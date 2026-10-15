import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AsyncDataLayer, TaskStore } from "@fusion/core";

const healthMocks = vi.hoisted(() => ({
  checkPostgresHealth: vi.fn(),
  detectTaskIdIntegrityAnomaliesAsync: vi.fn(),
  getSqliteMigrationState: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  checkPostgresHealth: healthMocks.checkPostgresHealth,
  detectTaskIdIntegrityAnomaliesAsync: healthMocks.detectTaskIdIntegrityAnomaliesAsync,
  getSqliteMigrationState: healthMocks.getSqliteMigrationState,
}));

import {
  evaluateDashboardPostgresHealth,
  resolveDashboardPostgresLayer,
} from "../dashboard-postgres-health.js";

/*
FNXC:PostgresHealth 2026-07-14-23:45:
Dashboard health must derive the live PostgreSQL layer from TaskStore, fail closed when that layer is unavailable, and surface task-ID detector failures instead of converting them into an "ok" report.
*/
describe("evaluateDashboardPostgresHealth", () => {
  const layer = { db: {}, healthDb: {} } as AsyncDataLayer;

  beforeEach(() => {
    vi.clearAllMocks();
    healthMocks.checkPostgresHealth.mockResolvedValue([]);
    healthMocks.detectTaskIdIntegrityAnomaliesAsync.mockResolvedValue({
      status: "ok",
      checkedAt: "2026-07-14T23:45:00.000Z",
      anomalies: [],
    });
    healthMocks.getSqliteMigrationState.mockResolvedValue(null);
  });

  it("derives and probes the PostgreSQL layer owned by TaskStore", async () => {
    const store = { getAsyncLayer: () => layer } as TaskStore;

    const result = await evaluateDashboardPostgresHealth(store);

    expect(healthMocks.checkPostgresHealth).toHaveBeenCalledWith(layer);
    expect(healthMocks.detectTaskIdIntegrityAnomaliesAsync).toHaveBeenCalledWith(layer.healthDb, { projectId: undefined });
    expect(result.database.healthy).toBe(true);
    expect(result.taskIdIntegrity.status).toBe("ok");
  });

  /*
  FNXC:PostgresHealth 2026-10-15-13:28 (RUFU-302):
  The healthy producer must publish ONLY the measured fields. `isRunning` used to
  be a hardcoded `false` here (a store snapshot member that leaked through the
  old `ReturnType<TaskStore["getDatabaseHealth"]>` derivation) and was read as
  DB-liveness proof it never was. Pin the closed key set so neither that flag nor
  any future store member can reappear on the produced health object.
  */
  it("produces only the measured database fields from the healthy path (no isRunning)", async () => {
    const store = { getAsyncLayer: () => layer } as TaskStore;

    const result = await evaluateDashboardPostgresHealth(store);

    expect(result.database).not.toHaveProperty("isRunning");
    expect(Object.keys(result.database).sort()).toEqual([
      "corruptionDetected",
      "corruptionErrors",
      "healthy",
      "lastCheckedAt",
    ]);
  });

  it("prefers the engine project context for task-ID integrity partitioning", async () => {
    const boundLayer = { ...layer, projectId: "layer-project" } as AsyncDataLayer;
    const store = { getAsyncLayer: () => boundLayer } as TaskStore;

    await evaluateDashboardPostgresHealth(store, undefined, { projectId: " daemon-project " });

    expect(healthMocks.detectTaskIdIntegrityAnomaliesAsync).toHaveBeenCalledWith(boundLayer.healthDb, {
      projectId: "daemon-project",
    });
  });

  it("uses the bound data-layer partition when engine context is absent", async () => {
    const boundLayer = { ...layer, projectId: "layer-project" } as AsyncDataLayer;
    const store = { getAsyncLayer: () => boundLayer } as TaskStore;

    await evaluateDashboardPostgresHealth(store);

    expect(healthMocks.detectTaskIdIntegrityAnomaliesAsync).toHaveBeenCalledWith(boundLayer.healthDb, {
      projectId: "layer-project",
    });
  });

  it("surfaces durable failed and running cutovers without an age threshold", async () => {
    const store = { getAsyncLayer: () => layer, getRootDir: () => "/repo" } as TaskStore;
    for (const status of ["failed", "running"] as const) {
      healthMocks.getSqliteMigrationState.mockResolvedValueOnce({
        migrationKey: "project:/repo",
        projectId: null,
        status,
        lastError: status === "failed" ? "copy failed" : null,
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      const result = await evaluateDashboardPostgresHealth(store);
      expect(result.migration).toMatchObject({ active: false, durableStatus: status, phase: status });
      expect(result.migration?.label).toBeTruthy();
    }
  });

  it("uses the typed bound project id before the root-directory fallback", async () => {
    const store = { getAsyncLayer: () => layer, getRootDir: () => "/repo" } as TaskStore;
    healthMocks.getSqliteMigrationState.mockResolvedValue({
      migrationKey: "project:daemon-project",
      projectId: "daemon-project",
      status: "failed",
      lastError: "copy failed",
      updatedAt: "2000-01-01T00:00:00.000Z",
    });

    const result = await evaluateDashboardPostgresHealth(store, undefined, {
      projectId: "daemon-project",
    });

    expect(healthMocks.getSqliteMigrationState).toHaveBeenCalledWith(layer.db, "project:daemon-project");
    expect(result.migration).toMatchObject({ migrationKey: "project:daemon-project", durableStatus: "failed" });
  });

  it("omits migration chrome for a complete marker", async () => {
    const store = { getAsyncLayer: () => layer, getRootDir: () => "/repo" } as TaskStore;
    healthMocks.getSqliteMigrationState.mockResolvedValue({
      migrationKey: "project:/repo", projectId: null, status: "complete", lastError: null, updatedAt: new Date(),
    });
    expect((await evaluateDashboardPostgresHealth(store)).migration).toBeUndefined();
  });

  it("uses an explicit integration layer for health and compaction without consulting TaskStore", () => {
    const getAsyncLayer = vi.fn(() => null);
    const store = { getAsyncLayer } as unknown as TaskStore;

    expect(resolveDashboardPostgresLayer(store, layer)).toBe(layer);
    expect(getAsyncLayer).not.toHaveBeenCalled();
  });

  it("fails closed when no PostgreSQL layer is available", async () => {
    const store = { getAsyncLayer: () => null } as TaskStore;

    const result = await evaluateDashboardPostgresHealth(store);

    expect(healthMocks.checkPostgresHealth).not.toHaveBeenCalled();
    expect(result.database).toMatchObject({
      healthy: false,
      // FNXC:TaskIdIntegrityCanary 2026-09-26-02:08 (RUFU-301): an unmeasured
      // canary is not a clean canary, so the boolean fails closed.
      corruptionDetected: true,
      corruptionErrors: ["PostgreSQL health layer unavailable"],
    });
    expect(result.taskIdIntegrity).toMatchObject({
      status: "error",
      error: "PostgreSQL health layer unavailable",
      // The evidence class rides the measurement it describes, which is what the
      // banner and the recommended action read.
      failure: "unconfigured",
    });
    // RUFU-302: the failed producer publishes the same closed key set — no isRunning.
    expect(result.database).not.toHaveProperty("isRunning");
    expect(Object.keys(result.database).sort()).toEqual([
      "corruptionDetected",
      "corruptionErrors",
      "healthy",
      "lastCheckedAt",
    ]);
  });

  /*
  FNXC:TaskIdIntegrityCanary 2026-09-26-04:35 (RUFU-301):
  Code-review P0. `checkPostgresHealth` never rejects for a dead backend: it
  RESOLVES a non-empty verdict list naming the connection failure, and its contract
  obliges the caller to surface the DB-corruption banner on a non-empty list. That
  list used to be discarded (`.then(() => null)`), so a downed PostgreSQL fell
  through into the integrity stage and was published as `failure: "incomplete"` —
  "PostgreSQL answered, … rather than assuming the database is down" — with the
  ECONNREFUSED evidence nowhere and the generic banner suppressed. Assert the real
  seam: the resolved verdict decides the class, the original sentence survives
  verbatim in `corruptionErrors`, and the integrity detector is never reached.
  */
  it("classifies a resolved unreachable verdict as a connectivity failure, not an unfinished measurement", async () => {
    const store = { getAsyncLayer: () => layer } as TaskStore;
    healthMocks.checkPostgresHealth.mockResolvedValue([
      "PostgreSQL backend unreachable: connect ECONNREFUSED 127.0.0.1:5432",
    ]);

    const result = await evaluateDashboardPostgresHealth(store);

    expect(result.taskIdIntegrity).toMatchObject({
      status: "error",
      failure: "unreachable",
      error: "PostgreSQL backend unreachable: connect ECONNREFUSED 127.0.0.1:5432",
    });
    expect(result.database).toMatchObject({
      healthy: false,
      // Pair invariant: a blocking error never travels with a clean-canary claim.
      corruptionDetected: true,
      corruptionErrors: ["PostgreSQL backend unreachable: connect ECONNREFUSED 127.0.0.1:5432"],
    });
    // Connectivity failed, so the integrity stage must not pretend to have run.
    expect(healthMocks.detectTaskIdIntegrityAnomaliesAsync).not.toHaveBeenCalled();
  });

  it("classifies a reachable server that refuses the database as unreachable", async () => {
    const store = { getAsyncLayer: () => layer } as TaskStore;
    healthMocks.checkPostgresHealth.mockResolvedValue([
      "PostgreSQL database is not accepting connections (datallowconn = false)",
    ]);

    const result = await evaluateDashboardPostgresHealth(store);

    expect(result.taskIdIntegrity).toMatchObject({ status: "error", failure: "unreachable" });
    expect(result.database.corruptionErrors).toEqual([
      "PostgreSQL database is not accepting connections (datallowconn = false)",
    ]);
    expect(healthMocks.detectTaskIdIntegrityAnomaliesAsync).not.toHaveBeenCalled();
  });

  it("returns a probe-timeout degradation instead of waiting for a saturated pool", async () => {
    vi.useFakeTimers();
    const store = { getAsyncLayer: () => layer } as TaskStore;
    healthMocks.checkPostgresHealth.mockImplementation(() => new Promise(() => {}));

    const pending = evaluateDashboardPostgresHealth(store, undefined, { probeTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    // RUFU-301: an expired deadline is a stalled measurement, so the copy names
    // the stage that produced no answer instead of the generic timeout wording.
    expect(result.database.corruptionErrors).toHaveLength(1);
    expect(result.database.corruptionErrors[0]).toContain(
      "PostgreSQL health probe did not complete within its 25ms stage budget",
    );
    expect(result.database.corruptionDetected).toBe(true);
    expect(result.taskIdIntegrity).toMatchObject({ status: "error", failure: "incomplete" });
    vi.useRealTimers();
  });

  it("degrades when the authoritative task-ID integrity probe times out", async () => {
    vi.useFakeTimers();
    const store = { getAsyncLayer: () => layer } as TaskStore;
    healthMocks.detectTaskIdIntegrityAnomaliesAsync.mockImplementation(() => new Promise(() => {}));

    const pending = evaluateDashboardPostgresHealth(store, undefined, { probeTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result.database.corruptionErrors).toHaveLength(1);
    expect(result.database.corruptionErrors[0]).toContain(
      "PostgreSQL task-ID integrity probe did not complete within its 25ms stage budget",
    );
    expect(result.database.corruptionDetected).toBe(true);
    expect(result.taskIdIntegrity).toMatchObject({ status: "error", failure: "incomplete" });
    vi.useRealTimers();
  });

  it("keeps a timed-out migration probe advisory", async () => {
    vi.useFakeTimers();
    const store = { getAsyncLayer: () => layer, getRootDir: () => "/repo" } as TaskStore;
    healthMocks.getSqliteMigrationState.mockImplementation(() => new Promise(() => {}));

    const pending = evaluateDashboardPostgresHealth(store, undefined, { probeTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result.database.healthy).toBe(true);
    expect(result.taskIdIntegrity.status).toBe("ok");
    expect(result.migration).toBeUndefined();
    vi.useRealTimers();
  });

  it("keeps a slow probe that finishes within its shared budget healthy", async () => {
    vi.useFakeTimers();
    const store = { getAsyncLayer: () => layer } as TaskStore;
    healthMocks.checkPostgresHealth.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve([]), 10);
    }));

    const pending = evaluateDashboardPostgresHealth(store, undefined, { probeTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.database.healthy).toBe(true);
    expect(result.taskIdIntegrity.status).toBe("ok");
    vi.useRealTimers();
  });

  it("applies the default deadline when no context is supplied", async () => {
    vi.useFakeTimers();
    const store = { getAsyncLayer: () => layer } as TaskStore;
    healthMocks.checkPostgresHealth.mockImplementation(() => new Promise(() => {}));

    const pending = evaluateDashboardPostgresHealth(store);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result.database.corruptionErrors).toHaveLength(1);
    expect(result.database.corruptionErrors[0]).toContain(
      "PostgreSQL health probe did not complete within its 5000ms stage budget",
    );
    expect(result.database.corruptionDetected).toBe(true);
    expect(result.taskIdIntegrity).toMatchObject({ status: "error", failure: "incomplete" });
    vi.useRealTimers();
  });

  it("degrades health when task-ID integrity detection throws", async () => {
    const store = { getAsyncLayer: () => layer } as TaskStore;
    healthMocks.detectTaskIdIntegrityAnomaliesAsync.mockRejectedValue(new Error("integrity query timed out"));

    const result = await evaluateDashboardPostgresHealth(store);

    expect(result.database).toMatchObject({
      healthy: false,
      corruptionDetected: true,
      corruptionErrors: ["PostgreSQL task-ID integrity check failed: integrity query timed out"],
    });
    expect(result.taskIdIntegrity).toMatchObject({
      status: "error",
      error: "PostgreSQL task-ID integrity check failed: integrity query timed out",
      failure: "incomplete",
    });
  });

  it("keeps advisory migration-status failures from degrading proven database health", async () => {
    const store = { getAsyncLayer: () => layer, getRootDir: () => "/repo" } as TaskStore;
    healthMocks.getSqliteMigrationState.mockRejectedValue(
      new Error("Failed query: SELECT migration marker", { cause: new Error("permission denied") }),
    );

    const result = await evaluateDashboardPostgresHealth(store);

    expect(result.database).toMatchObject({
      healthy: true,
      corruptionDetected: false,
      corruptionErrors: [],
    });
    expect(result.taskIdIntegrity).toMatchObject({ status: "ok", anomalies: [] });
    expect(result.migration).toBeUndefined();
  });
});

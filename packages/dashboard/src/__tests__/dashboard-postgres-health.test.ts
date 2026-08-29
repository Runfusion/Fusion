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
  const layer = { db: {} } as AsyncDataLayer;

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
    expect(healthMocks.detectTaskIdIntegrityAnomaliesAsync).toHaveBeenCalledWith(layer.db);
    expect(result.database.healthy).toBe(true);
    expect(result.taskIdIntegrity.status).toBe("ok");
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
      corruptionDetected: false,
      corruptionErrors: ["PostgreSQL health layer unavailable"],
    });
    expect(result.taskIdIntegrity).toMatchObject({
      status: "error",
      error: "PostgreSQL health layer unavailable",
    });
  });

  it("returns a probe-timeout degradation instead of waiting for a saturated pool", async () => {
    vi.useFakeTimers();
    const store = { getAsyncLayer: () => layer } as TaskStore;
    healthMocks.checkPostgresHealth.mockImplementation(() => new Promise(() => {}));

    const pending = evaluateDashboardPostgresHealth(store, undefined, { probeTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result.database.corruptionErrors).toEqual([
      "PostgreSQL health probe timed out after 25ms (connection pool saturated?)",
    ]);
    vi.useRealTimers();
  });

  it("degrades when the authoritative task-ID integrity probe times out", async () => {
    vi.useFakeTimers();
    const store = { getAsyncLayer: () => layer } as TaskStore;
    healthMocks.detectTaskIdIntegrityAnomaliesAsync.mockImplementation(() => new Promise(() => {}));

    const pending = evaluateDashboardPostgresHealth(store, undefined, { probeTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result.database.corruptionErrors).toEqual([
      "PostgreSQL task-ID integrity probe timed out after 25ms (connection pool saturated?)",
    ]);
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

    expect(result.database.corruptionErrors).toEqual([
      "PostgreSQL health probe timed out after 5000ms (connection pool saturated?)",
    ]);
    vi.useRealTimers();
  });

  it("degrades health when task-ID integrity detection throws", async () => {
    const store = { getAsyncLayer: () => layer } as TaskStore;
    healthMocks.detectTaskIdIntegrityAnomaliesAsync.mockRejectedValue(new Error("integrity query timed out"));

    const result = await evaluateDashboardPostgresHealth(store);

    expect(result.database).toMatchObject({
      healthy: false,
      corruptionDetected: false,
      corruptionErrors: ["PostgreSQL task-ID integrity check failed: integrity query timed out"],
    });
    expect(result.taskIdIntegrity).toMatchObject({
      status: "error",
      error: "PostgreSQL task-ID integrity check failed: integrity query timed out",
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

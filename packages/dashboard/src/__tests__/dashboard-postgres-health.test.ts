import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AsyncDataLayer, TaskStore } from "@fusion/core";

const healthMocks = vi.hoisted(() => ({
  checkPostgresHealth: vi.fn(),
  detectTaskIdIntegrityAnomaliesAsync: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  checkPostgresHealth: healthMocks.checkPostgresHealth,
  detectTaskIdIntegrityAnomaliesAsync: healthMocks.detectTaskIdIntegrityAnomaliesAsync,
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
  });

  it("derives and probes the PostgreSQL layer owned by TaskStore", async () => {
    const store = { getAsyncLayer: () => layer } as TaskStore;

    const result = await evaluateDashboardPostgresHealth(store);

    expect(healthMocks.checkPostgresHealth).toHaveBeenCalledWith(layer);
    expect(healthMocks.detectTaskIdIntegrityAnomaliesAsync).toHaveBeenCalledWith(layer.db);
    expect(result.database.healthy).toBe(true);
    expect(result.taskIdIntegrity.status).toBe("ok");
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
      corruptionDetected: true,
      corruptionErrors: ["PostgreSQL health layer unavailable"],
    });
    expect(result.taskIdIntegrity).toMatchObject({
      status: "error",
      error: "PostgreSQL health layer unavailable",
    });
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
    });
  });
});

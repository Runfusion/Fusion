// @vitest-environment node
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerSystemMaintenanceRoutes } from "../register-system-maintenance-routes.js";

const core = vi.hoisted(() => ({
  BACKUP_SCHEDULE_NAME: "database-backup",
  GlobalRoutineStore: vi.fn(),
  buildBackupScheduleStatus: vi.fn(),
  createBackupManager: vi.fn(),
  resolveGlobalBackupRoot: vi.fn(() => "/backups"),
  runBackupCommand: vi.fn(),
}));
const { BACKUP_SCHEDULE_NAME, GlobalRoutineStore, buildBackupScheduleStatus, createBackupManager, resolveGlobalBackupRoot, runBackupCommand } = core;
vi.mock("@fusion/core", async () => ({
  ...(await vi.importActual<typeof import("@fusion/core")>("@fusion/core")),
  findVitestProcessIds: vi.fn().mockResolvedValue([]),
  BACKUP_SCHEDULE_NAME: core.BACKUP_SCHEDULE_NAME,
  GlobalRoutineStore: core.GlobalRoutineStore,
  buildBackupScheduleStatus: core.buildBackupScheduleStatus,
  createBackupManager: core.createBackupManager,
  resolveGlobalBackupRoot: core.resolveGlobalBackupRoot,
  runBackupCommand: core.runBackupCommand,
}));

function app(store: Record<string, unknown>) {
  const router = express.Router();
  registerSystemMaintenanceRoutes({ router, getProjectContext: vi.fn().mockResolvedValue({ store }) } as never);
  const server = express();
  server.use(express.json());
  server.use("/api", router);
  server.use((err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.statusCode ?? 500).json({ error: err.message }));
  return server;
}

describe("registerSystemMaintenanceRoutes", () => {
  it("runs legacy auto-merge dry-run and apply contracts", async () => {
    const reconcileLegacyAutoMergeStamps = vi.fn().mockResolvedValueOnce(["a"]).mockResolvedValueOnce(["a", "b"]);
    const server = app({ reconcileLegacyAutoMergeStamps });
    expect((await request(server, "GET", "/api/maintenance/legacy-automerge-stamps")).body).toEqual({ candidates: ["a"], count: 1 });
    expect((await request(server, "POST", "/api/maintenance/legacy-automerge-stamps/apply")).body).toEqual({ cleared: ["a", "b"], count: 2 });
    expect(reconcileLegacyAutoMergeStamps).toHaveBeenNthCalledWith(1);
    expect(reconcileLegacyAutoMergeStamps).toHaveBeenNthCalledWith(2, { apply: true });
  });

  it("lists newest backups with schedule status and preserves POST failures", async () => {
    const listBackups = vi.fn().mockResolvedValue([
      { filename: "older", createdAt: "2026-01-01T00:00:00.000Z", size: 3 },
      { filename: "newer", createdAt: "2026-02-01T00:00:00.000Z", size: 7 },
    ]);
    const routine = { name: BACKUP_SCHEDULE_NAME };
    const getByName = vi.fn().mockResolvedValue(routine);
    GlobalRoutineStore.mockImplementation(function () { return { getByName }; });
    buildBackupScheduleStatus.mockReturnValue({ enabled: true, routineRegistered: true });
    createBackupManager.mockReturnValue({ listBackups });
    runBackupCommand.mockResolvedValueOnce({ success: true, backupPath: "/backups/a", output: "ok", deletedCount: 1 }).mockResolvedValueOnce({ success: false, output: "disk full" });
    const server = app({ getSettings: vi.fn().mockResolvedValue({}), getAsyncLayer: vi.fn(() => ({})) });
    expect((await request(server, "GET", "/api/backups")).body).toEqual({
      backups: [
        { filename: "newer", createdAt: "2026-02-01T00:00:00.000Z", size: 7 },
        { filename: "older", createdAt: "2026-01-01T00:00:00.000Z", size: 3 },
      ],
      count: 2,
      totalSize: 10,
      schedule: { enabled: true, routineRegistered: true },
    });
    expect(getByName).toHaveBeenCalledWith(BACKUP_SCHEDULE_NAME);
    expect((await request(server, "POST", "/api/backups")).body).toEqual({ success: true, backupPath: "/backups/a", output: "ok", deletedCount: 1 });
    const failed = await request(server, "POST", "/api/backups");
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "disk full" });
  });

  it("returns schedule evidence when listing backups fails or no routine is registered", async () => {
    GlobalRoutineStore.mockImplementation(function () { return { getByName: vi.fn().mockResolvedValue(undefined) }; });
    buildBackupScheduleStatus.mockReturnValue({ enabled: true, routineRegistered: false });
    createBackupManager.mockReturnValue({ listBackups: vi.fn().mockRejectedValue(new Error("PostgreSQL unavailable")) });
    const response = await request(app({ getSettings: vi.fn().mockResolvedValue({}), getAsyncLayer: vi.fn(() => ({})) }), "GET", "/api/backups");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ backups: [], count: 0, totalSize: 0, schedule: { enabled: true, routineRegistered: false }, listError: "PostgreSQL unavailable" });
  });
});

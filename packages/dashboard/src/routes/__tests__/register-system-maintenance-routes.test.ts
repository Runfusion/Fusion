// @vitest-environment node
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerSystemMaintenanceRoutes } from "../register-system-maintenance-routes.js";

const core = vi.hoisted(() => ({ createBackupManager: vi.fn(), resolveGlobalBackupRoot: vi.fn(() => "/backups"), runBackupCommand: vi.fn() }));
const { createBackupManager, resolveGlobalBackupRoot, runBackupCommand } = core;
vi.mock("@fusion/core", async () => ({
  ...(await vi.importActual<typeof import("@fusion/core")>("@fusion/core")),
  findVitestProcessIds: vi.fn().mockResolvedValue([]),
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

  it("lists backups and maps failed backup command output to 500", async () => {
    const listBackups = vi.fn().mockResolvedValue([{ size: 3 }, { size: 7 }]);
    createBackupManager.mockReturnValue({ listBackups });
    runBackupCommand.mockResolvedValueOnce({ success: true, backupPath: "/backups/a", output: "ok", deletedCount: 1 }).mockResolvedValueOnce({ success: false, output: "disk full" });
    const server = app({ getSettings: vi.fn().mockResolvedValue({}) });
    expect((await request(server, "GET", "/api/backups")).body).toEqual({ backups: [{ size: 3 }, { size: 7 }], count: 2, totalSize: 10 });
    expect((await request(server, "POST", "/api/backups")).body).toEqual({ success: true, backupPath: "/backups/a", output: "ok", deletedCount: 1 });
    const failed = await request(server, "POST", "/api/backups");
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "disk full" });
  });
});

// @vitest-environment node
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerActivityLogRoutes, registerSetupActivityRoutes } from "../register-setup-activity-routes.js";

const core = vi.hoisted(() => ({ completeSetup: vi.fn(), central: {} as Record<string, unknown> }));
const { completeSetup } = core;
vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: class { constructor() { return core.central; } },
    MigrationCoordinator: class { completeSetup = completeSetup; },
  };
});

function server(activityStore: Record<string, unknown> = {}, central: Record<string, unknown> = {}) {
  core.central = { init: vi.fn(), close: vi.fn(), ...central };
  const router = express.Router();
  const context = { router, getProjectContext: vi.fn().mockResolvedValue({ store: activityStore }), options: { centralCore: central } };
  registerActivityLogRoutes(context as never); registerSetupActivityRoutes(context as never);
  const app = express(); app.use(express.json()); app.use("/api", router);
  app.use((err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.statusCode ?? 500).json({ error: err.message }));
  return app;
}

describe("register setup/activity route contracts", () => {
  it("validates and forwards activity queries and clears the log", async () => {
    const getActivityLog = vi.fn().mockResolvedValue([{ id: "a" }]); const clearActivityLog = vi.fn(); const app = server({ getActivityLog, clearActivityLog });
    expect((await request(app, "GET", "/api/activity")).body).toEqual([{ id: "a" }]); expect(getActivityLog).toHaveBeenCalledWith({ limit: 100, since: undefined, type: undefined });
    expect((await request(app, "GET", "/api/activity?limit=-1")).status).toBe(400); expect((await request(app, "GET", "/api/activity?type=nope")).status).toBe(400);
    await request(app, "GET", "/api/activity?limit=7&type=task:created"); expect(getActivityLog).toHaveBeenLastCalledWith({ limit: 7, since: undefined, type: "task:created" });
    expect((await request(app, "DELETE", "/api/activity")).body).toEqual({ success: true }); expect(clearActivityLog).toHaveBeenCalledOnce();
  });
  /*
  FNXC:CapacityModel 2026-07-29-03:40 (drop the cross-project cap — settings half):
  GET /api/global-concurrency now returns TELEMETRY ONLY. `globalMaxConcurrent` and
  `queuedCount` are gone from the payload: the cap is deleted (capacity is two
  numbers PER PROJECT) and `queuedCount` came from slot bookkeeping production code
  never incremented, so publishing it was publishing a zero dressed as state. The
  route no longer calls `getGlobalConcurrencyState` at all — it reads live counts
  through CentralCore's side-effect-safe source, which is asserted here.

  The PUT bounds case is DELETED with the route. It validated 0/10001/1.5/"2" -> 400
  for a limit that no longer exists; there is nothing left to bound.
  */
  it("uses the supplied CentralCore for feed and live running-agent counts", async () => {
    const getRecentActivity = vi.fn().mockResolvedValue([{ id: "feed" }]); const getLiveRunningAgentCounts = vi.fn().mockResolvedValue({ currentlyActive: 3, projectsActive: 2 });
    const app = server({}, { getRecentActivity, getLiveRunningAgentCounts });
    expect((await request(app, "GET", "/api/activity-feed?limit=8&projectId=p&types=task:created,task:moved")).body).toEqual([{ id: "feed" }]); expect(getRecentActivity).toHaveBeenCalledWith({ limit: 8, projectId: "p", types: ["task:created", "task:moved"] });
    expect((await request(app, "GET", "/api/global-concurrency")).body).toEqual({ currentlyActive: 3, projectsActive: 2 });
    expect(getLiveRunningAgentCounts).toHaveBeenCalled();
  });
  it("rejects non-array setup projects and completes valid setup", async () => {
    completeSetup.mockResolvedValue({ success: true, projectsRegistered: 1, errors: [] });
    const app = server({}, { isInitialized: () => true });
    expect((await request(app, "POST", "/api/complete-setup", JSON.stringify({ projects: {} }), { "Content-Type": "application/json" })).status).toBe(400);
    expect((await request(app, "POST", "/api/complete-setup", JSON.stringify({ projects: [{ path: "/p", name: "P" }] }), { "Content-Type": "application/json" })).body).toEqual({ success: true, projectsRegistered: 1, errors: [] });
    expect(completeSetup).toHaveBeenCalledWith([{ path: "/p", name: "P" }]);
  });
});

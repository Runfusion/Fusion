// @vitest-environment node
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";
import { registerActivityLogRoutes, registerSetupActivityRoutes } from "../routes/register-setup-activity-routes.js";

function app() {
  const router = express.Router();
  const store = { getActivityLog: vi.fn().mockResolvedValue([]) };
  const centralCore = { isInitialized: () => true, getRecentActivity: vi.fn().mockResolvedValue([]) };
  const context = { router, getProjectContext: vi.fn().mockResolvedValue({ store }), options: { centralCore } } as never;
  registerActivityLogRoutes(context);
  registerSetupActivityRoutes(context);
  const server = express();
  server.use("/api", router);
  server.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? 500).json({ error: error.message }));
  return { server, store, centralCore };
}

describe("Activity Log task-ID routes", () => {
  it("forwards exact task filters through project and central read boundaries", async () => {
    const { server, store, centralCore } = app();
    expect((await request(server, "GET", "/api/activity?taskId=FN-066&type=task%3Amoved&since=2026-08-20T04%3A16%3A00.000Z")).status).toBe(200);
    expect(store.getActivityLog).toHaveBeenCalledWith(expect.objectContaining({ taskId: "FN-066", type: "task:moved", since: "2026-08-20T04:16:00.000Z" }));

    expect((await request(server, "GET", "/api/activity-feed?taskId=FN-066&projectId=project-a&types=task%3Amoved&since=2026-08-20T04%3A16%3A00.000Z")).status).toBe(200);
    expect(centralCore.getRecentActivity).toHaveBeenCalledWith(expect.objectContaining({ taskId: "FN-066", projectId: "project-a", types: ["task:moved"], since: "2026-08-20T04:16:00.000Z" }));
  });

  it("rejects repeated task-ID query values", async () => {
    const { server } = app();
    expect((await request(server, "GET", "/api/activity?taskId=FN-066&taskId=FN-999")).status).toBe(400);
    expect((await request(server, "GET", "/api/activity-feed?taskId=FN-066&taskId=FN-999")).status).toBe(400);
  });
});

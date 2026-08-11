// @vitest-environment node
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";

const queryAgentActivityEvents = vi.hoisted(() => vi.fn());
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  queryAgentActivityEvents,
}));

import { registerActivityLogRoutes } from "../routes/register-setup-activity-routes.js";

/*
FNXC:AgentActivityStream 2026-08-09-12:59:
The public route deliberately owns input validation while the core helper owns the defensive
limit clamp. These route checks pin decimal seq cursors and ensure callers cannot request tail
ordering or inject a non-stream activity type.
*/
function app() {
  const router = express.Router();
  registerActivityLogRoutes({
    router,
    getProjectContext: vi.fn().mockResolvedValue({ store: { getAsyncLayer: () => ({ projectId: "project-a" }) } }),
  } as never);
  const server = express();
  server.use("/api", router);
  server.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? 500).json({ error: error.message }));
  return server;
}

describe("GET /api/agent-activity", () => {
  beforeEach(() => queryAgentActivityEvents.mockReset().mockResolvedValue({ events: [], nextCursor: null }));

  it("defaults and clamps limits while forwarding composable filters", async () => {
    const server = app();
    await request(server, "GET", "/api/agent-activity?limit=5000&agentId=agent-deadbeef&taskId=FN-8864&type=task:started&order=asc");
    expect(queryAgentActivityEvents).toHaveBeenCalledWith(
      { projectId: "project-a" },
      expect.objectContaining({ limit: 1000, agentId: "agent-deadbeef", taskId: "FN-8864", type: "task:started" }),
    );
    expect(queryAgentActivityEvents.mock.calls[0]?.[1]).not.toHaveProperty("order");

    await request(server, "GET", "/api/agent-activity");
    expect(queryAgentActivityEvents.mock.calls[1]?.[1]).toMatchObject({ limit: 100 });
  });

  it("accepts and forwards a zero limit", async () => {
    // docs/agent-activity-contract.md#filters-and-limits
    const response = await request(app(), "GET", "/api/agent-activity?limit=0");
    expect(response.status).toBe(200);
    expect(queryAgentActivityEvents).toHaveBeenCalledWith(
      { projectId: "project-a" },
      expect.objectContaining({ limit: 0 }),
    );
  });

  it("rejects invalid limits, cursors, and event types", async () => {
    const server = app();
    for (const query of ["limit=-1", "limit=1.5", "limit=nope", "before=one", "since=1.5", "type=nope"]) {
      const response = await request(server, "GET", `/api/agent-activity?${query}`);
      expect(response.status).toBe(400);
    }
  });

  it("returns the core newest-first page shape unchanged", async () => {
    queryAgentActivityEvents.mockResolvedValueOnce({
      events: [{ seq: "2", eventId: "evt_0000000000000002", agentAttribution: "agent" }],
      nextCursor: "1",
    });
    const response = await request(app(), "GET", "/api/agent-activity?before=3&since=0");
    expect(response.body).toEqual({ events: [{ seq: "2", eventId: "evt_0000000000000002", agentAttribution: "agent" }], nextCursor: "1" });
    expect(queryAgentActivityEvents).toHaveBeenLastCalledWith(
      { projectId: "project-a" },
      expect.objectContaining({ before: "3", since: "0" }),
    );
  });
});

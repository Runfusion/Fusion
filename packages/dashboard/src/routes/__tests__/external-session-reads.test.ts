import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { ExternalSessionAttribution, ExternalSessionReader, ExternalSessionTurnReader, externalSessionPageCursor } from "@fusion/core";
import type { ApiRoutesContext } from "../types.js";
import { registerExternalSessionRoutes } from "../register-external-session-routes.js";
import { summarizeSessionCost } from "../../remote-agents/session-cost.js";
import { createAuthMiddleware } from "../../auth-middleware.js";

type Handler = (req: Request, res: Response) => Promise<void>;
const id = "a".repeat(64);
function setup() {
  const handlers = new Map<string, Handler>();
  // The list route prices each session, so the store must expose settings like the real one does.
  const getProjectContext = vi.fn(async () => ({ projectId: "project-a", store: {
    getAsyncLayer: () => ({ projectId: "project-a" }),
    getGlobalSettingsStore: () => ({ getSettings: async () => ({}) }),
  } }));
  registerExternalSessionRoutes({ router: { post: vi.fn(), get: (path: string, handler: Handler) => handlers.set(path, handler) },
    getProjectContext, options: {} } as unknown as ApiRoutesContext);
  const req = { query: { projectId: "project-a" }, params: { id }, headers: {} } as unknown as Request;
  const json = vi.fn(); const status = vi.fn(); const res = { json, status } as unknown as Response; status.mockReturnValue(res);
  return { handlers, getProjectContext, req, res, json, status };
}
beforeEach(() => vi.restoreAllMocks());

describe("project-scoped remote-session reads", () => {
  it("uses dashboard authentication even with a collector bearer credential", () => {
    const s = setup(); const token = randomBytes(32).toString("hex");
    s.req.headers.authorization = `Bearer ${token}`;
    const gate = createAuthMiddleware(randomBytes(32).toString("hex"));
    for (const path of ["/api/external-sessions", `/api/external-sessions/${id}`, "/api/external-sessions/by-task/FN-1"]) {
      Object.assign(s.req, { method: "GET", path }); const next = vi.fn();
      gate(s.req, s.res, next);
      expect(next).not.toHaveBeenCalled(); expect(s.status).toHaveBeenCalledWith(401);
    }
  });
  it("returns bounded exact filters and rejects malformed queries or cross-project cursors", async () => {
    const page = { schemaVersion: 1 as const, sessions: [], nextCursor: null };
    const list = vi.spyOn(ExternalSessionReader.prototype, "list").mockResolvedValue(page);
    const s = setup(); s.req.query = { projectId: "project-a", hostId: "host-a", provider: "runtime", limit: "2" };
    await s.handlers.get("/external-sessions")!(s.req, s.res);
    expect(list).toHaveBeenCalledWith({ hostId: "host-a", provider: "runtime", limit: 2 });
    expect(s.json).toHaveBeenCalledWith(page);
    for (const query of [{ limit: "101" }, { limit: "1.5" }, { hostId: ["a", "b"] },
      { cursor: externalSessionPageCursor("other", {}, id) }]) {
      s.req.query = { projectId: "project-a", ...query };
      await expect(s.handlers.get("/external-sessions")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(list).toHaveBeenCalledTimes(1);
  });
  it("prices every listed session so the list and the detail cannot disagree", async () => {
    const usage = [{ model: "gpt-5.6-sol", inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0, outputTokens: 100, reasoningTokens: null, fast: false, longContext: false }];
    const session = { id, hostId: "host-a", provider: "codex", nativeSessionId: "native", revision: 1,
      observation: { provider: "codex", nativeSessionId: "native", revision: 1, activity: "working", observedAt: new Date().toISOString(), usage, usageComplete: true },
      receivedAt: new Date().toISOString(), lastHeartbeatAt: null, collectorConnected: true, activityStale: false } as never;
    vi.spyOn(ExternalSessionReader.prototype, "list").mockResolvedValue({ schemaVersion: 1 as const, sessions: [session], nextCursor: null });
    const s = setup();
    await s.handlers.get("/external-sessions")!(s.req, s.res);
    const listed = s.json.mock.calls[0]![0].sessions[0];
    expect(typeof listed.cost.estimatedUsd).toBe("number");
    expect(listed.cost).toMatchObject({ usageComplete: true, unpricedRecords: 0 });
    // The card total must equal what the detail route reports for the same session.
    expect(listed.cost.estimatedUsd).toBe(summarizeSessionCost(session).estimatedUsd);
  });

  it("marks an unmapped provider unpriced instead of reporting a total", async () => {
    const usage = [{ model: "gpt-5.6-sol", inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0, outputTokens: 100, reasoningTokens: null, fast: false, longContext: false }];
    const session = { id, hostId: "host-a", provider: "manual-test", nativeSessionId: "native", revision: 1,
      observation: { provider: "manual-test", nativeSessionId: "native", revision: 1, activity: "working", observedAt: new Date().toISOString(), usage, usageComplete: true },
      receivedAt: new Date().toISOString(), lastHeartbeatAt: null, collectorConnected: true, activityStale: false } as never;
    vi.spyOn(ExternalSessionReader.prototype, "list").mockResolvedValue({ schemaVersion: 1 as const, sessions: [session], nextCursor: null });
    const s = setup();
    await s.handlers.get("/external-sessions")!(s.req, s.res);
    expect(s.json.mock.calls[0]![0].sessions[0].cost).toMatchObject({ estimatedUsd: null, partialUsd: null, unpricedRecords: 1 });
  });

  it("hides unknown and other-project identities and rejects a storage mismatch", async () => {
    const get = vi.spyOn(ExternalSessionReader.prototype, "get").mockResolvedValue(null);
    const s = setup();
    await expect(s.handlers.get("/external-sessions/:id")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 404 });
    expect(get).toHaveBeenCalledWith(id);
    s.req.params.id = "not-an-id";
    await expect(s.handlers.get("/external-sessions/:id")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 400 });
    s.req.params.id = id;
    s.getProjectContext.mockResolvedValue({ projectId: "project-a", store: { getAsyncLayer: () => ({ projectId: "other" }) } });
    await expect(s.handlers.get("/external-sessions/:id")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 503 });
    expect(get).toHaveBeenCalledTimes(1);
  });
  // FNXC:ExternalSessionAttribution 2026-09-26-23:39: task detail lists only sessions attribution proves are this task's runs.
  it("lists a task's proven sessions and rejects malformed task ids or mismatched storage", async () => {
    const proven = vi.spyOn(ExternalSessionAttribution.prototype, "sessionIdsForTask").mockResolvedValue([id, "b".repeat(64)]);
    // A proven id whose row vanished between the two reads is dropped, not returned as null.
    const get = vi.spyOn(ExternalSessionReader.prototype, "get").mockImplementation(async sid => sid === id ? { id } as never : null);
    const s = setup(); s.req.params = { taskId: "FN-42" } as never;
    await s.handlers.get("/external-sessions/by-task/:taskId")!(s.req, s.res);
    expect(proven).toHaveBeenCalledWith("FN-42");
    expect(get).toHaveBeenCalledTimes(2);
    expect(s.json).toHaveBeenCalledWith({ schemaVersion: 1, taskId: "FN-42", sessions: [{ id }] });
    for (const taskId of ["", "FN 1", "../x", "x".repeat(129)]) {
      s.req.params = { taskId } as never;
      await expect(s.handlers.get("/external-sessions/by-task/:taskId")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 400 });
    }
    s.req.params = { taskId: "FN-42" } as never;
    s.getProjectContext.mockResolvedValue({ projectId: "project-a", store: { getAsyncLayer: () => ({ projectId: "other" }) } } as never);
    await expect(s.handlers.get("/external-sessions/by-task/:taskId")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 503 });
    expect(proven).toHaveBeenCalledTimes(1);
  });
  it("returns paginated turns and rejects malformed turn cursors", async () => {
    const page = { schemaVersion: 1 as const, turns: [], nextCursor: null };
    const list = vi.spyOn(ExternalSessionTurnReader.prototype, "list").mockResolvedValue(page);
    const s = setup(); s.req.query = { projectId: "project-a", limit: "25" };
    await s.handlers.get("/external-sessions/:id/turns")!(s.req, s.res);
    expect(list).toHaveBeenCalledWith(id, { limit: 25 });
    expect(s.json).toHaveBeenCalledWith(page);
    for (const query of [{ limit: "101" }, { limit: "1.5" }, { cursor: ["bad"] }]) {
      s.req.query = { projectId: "project-a", ...query } as typeof s.req.query;
      await expect(s.handlers.get("/external-sessions/:id/turns")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(list).toHaveBeenCalledTimes(1);
  });
});

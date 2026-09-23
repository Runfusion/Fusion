import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { ExternalSessionReader, externalSessionPageCursor } from "@fusion/core";
import type { ApiRoutesContext } from "../types.js";
import { registerExternalSessionRoutes } from "../register-external-session-routes.js";
import { createAuthMiddleware } from "../../auth-middleware.js";

type Handler = (req: Request, res: Response) => Promise<void>;
const id = "a".repeat(64);
function setup() {
  const handlers = new Map<string, Handler>();
  const getProjectContext = vi.fn(async () => ({ projectId: "project-a", store: { getAsyncLayer: () => ({ projectId: "project-a" }) } }));
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
    for (const path of ["/api/external-sessions", `/api/external-sessions/${id}`]) {
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
});

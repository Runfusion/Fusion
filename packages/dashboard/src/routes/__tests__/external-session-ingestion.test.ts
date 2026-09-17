import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { ExternalSessionStore, ExternalSessionConflict } from "@fusion/core";
import type { ApiRoutesContext } from "../types.js";
import { registerExternalSessionRoutes } from "../register-external-session-routes.js";
import { createAuthMiddleware } from "../../auth-middleware.js";
import { parseExternalSessionCollectorCredentials } from "../external-session-collector-auth.js";

const token = "collector-secret-only-for-tests";
const credential = { projectId: "project-1", hostId: "host-1", tokenSha256: createHash("sha256").update(token).digest("hex") };
const body = { schemaVersion: 1, streamId: "spool", sequence: 1, eventId: "event-1", collectorVersion: "1.0",
  session: { provider: "other-provider", nativeSessionId: "native-1", revision: 1, activity: "waiting", observedAt: "2026-09-17T00:00:00Z" } };
const ack = { schemaVersion: 1, streamId: "spool", acknowledgedSequence: 1, sessionId: "session-id", applied: true };
type Handler = (req: Request, res: Response) => Promise<void>;

function setup(config: unknown = [credential]) {
  const handlers = new Map<string, Handler>();
  const getProjectContext = vi.fn(async () => ({ projectId: "project-1", store: { getAsyncLayer: () => ({ projectId: "project-1" }) } }));
  registerExternalSessionRoutes({ router: { post: (path: string, handler: Handler) => handlers.set(path, handler) },
    options: { externalSessionCollectors: config }, getProjectContext } as unknown as ApiRoutesContext);
  const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
  const req = { headers: { authorization: `Bearer ${token}` }, query: { projectId: "project-1" }, body } as unknown as Request;
  return { handlers, getProjectContext, req, res: res as unknown as Response, json: res.json, status: res.status };
}

beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("FUSION_EXTERNAL_SESSION_COLLECTORS", ""); });

describe("external-session ingestion registrar", () => {
  it("authenticates the host/project credential before resolving storage and returns a committed ack", async () => {
    const ingest = vi.spyOn(ExternalSessionStore.prototype, "ingest").mockResolvedValue(ack as Awaited<ReturnType<ExternalSessionStore["ingest"]>>);
    const s = setup();
    await s.handlers.get("/external-sessions/ingest")!(s.req, s.res);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1, session: expect.objectContaining({ provider: "other-provider" }) }));
    expect(s.json).toHaveBeenCalledWith(ack);
    expect(s.getProjectContext).toHaveBeenCalledTimes(1);
  });

  it("keeps heartbeat separate from observation ingestion", async () => {
    const heartbeat = vi.spyOn(ExternalSessionStore.prototype, "heartbeat").mockResolvedValue();
    const ingest = vi.spyOn(ExternalSessionStore.prototype, "ingest");
    const s = setup(); s.req.body = { schemaVersion: 1, collectorVersion: "1.0" };
    await s.handlers.get("/external-sessions/heartbeat")!(s.req, s.res);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
    expect(s.json).toHaveBeenCalledWith({ schemaVersion: 1, hostId: "host-1" });
  });

  it.each(["wrong", "", undefined])("rejects invalid/missing header credential %s before database access", async tokenValue => {
    const s = setup(); s.req.headers.authorization = tokenValue ? `Bearer ${tokenValue}` : undefined;
    await expect(s.handlers.get("/external-sessions/ingest")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 401 });
    expect(s.getProjectContext).not.toHaveBeenCalled();
  });

  it("rejects browser/query credentials, cross-project claims and forged body identity", async () => {
    for (const mutate of [
      (req: Request) => { req.headers.origin = "https://browser.test"; },
      (req: Request) => { req.headers["sec-fetch-site"] = "same-origin"; },
      (req: Request) => { req.headers.authorization = undefined; req.query.fn_token = token; },
      (req: Request) => { req.query.projectId = "other"; },
      (req: Request) => { req.body = { ...body, hostId: "forged" }; },
      (req: Request) => { req.body = { ...body, session: { ...body.session, capabilities: ["stop"] } }; },
    ]) {
      const s = setup(); mutate(s.req);
      await expect(s.handlers.get("/external-sessions/ingest")!(s.req, s.res)).rejects.toBeInstanceOf(Error);
      expect(s.getProjectContext).not.toHaveBeenCalled();
    }
  });

  it("fails closed on invalid, empty and ambiguous configuration", async () => {
    for (const config of [[], [{ ...credential, tokenSha256: "invalid" }], [credential, { ...credential, hostId: "other" }], "bad-json"]) {
      const s = setup(config);
      await expect(s.handlers.get("/external-sessions/heartbeat")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 503 });
      expect(s.getProjectContext).not.toHaveBeenCalled();
    }
    expect(parseExternalSessionCollectorCredentials([credential, { ...credential, tokenSha256: "0".repeat(64) }])).toHaveLength(2);
  });

  it("is disabled without options or environment, and accepts hashed environment configuration", async () => {
    vi.unstubAllEnvs();
    delete process.env.FUSION_EXTERNAL_SESSION_COLLECTORS;
    const disabled = setup(undefined);
    // setup's default parameter is explicit; remove it to test the absent configuration below.
    const handlers = new Map<string, Handler>();
    registerExternalSessionRoutes({ router: { post: (path: string, handler: Handler) => handlers.set(path, handler) }, options: {} } as unknown as ApiRoutesContext);
    await expect(handlers.get("/external-sessions/ingest")!(disabled.req, disabled.res)).rejects.toMatchObject({ statusCode: 404 });
    vi.stubEnv("FUSION_EXTERNAL_SESSION_COLLECTORS", JSON.stringify([credential]));
    vi.spyOn(ExternalSessionStore.prototype, "ingest").mockResolvedValue(ack as Awaited<ReturnType<ExternalSessionStore["ingest"]>>);
    const env = setup(null);
    // Construct with no overriding options; the resolver seam remains the same.
    registerExternalSessionRoutes({ router: { post: (path: string, handler: Handler) => env.handlers.set(path, handler) }, getProjectContext: env.getProjectContext } as unknown as ApiRoutesContext);
    await env.handlers.get("/external-sessions/ingest")!(env.req, env.res);
    expect(env.json).toHaveBeenCalledWith(ack);
  });

  it("reports recoverable ordering conflicts and never acknowledges durability errors", async () => {
    const ingest = vi.spyOn(ExternalSessionStore.prototype, "ingest").mockRejectedValue(new ExternalSessionConflict("sequence-gap", 3));
    const s = setup(); await s.handlers.get("/external-sessions/ingest")!(s.req, s.res);
    expect(s.status).toHaveBeenCalledWith(409);
    expect(s.json).toHaveBeenCalledWith({ error: "sequence-gap", acknowledgedSequence: 3 });
    ingest.mockRejectedValue(new Error("durability failure")); s.json.mockClear();
    await expect(s.handlers.get("/external-sessions/ingest")!(s.req, s.res)).rejects.toThrow("durability failure");
    expect(s.json).not.toHaveBeenCalled();
  });
});

describe("dashboard authentication boundary", () => {
  it("exempts only exact collector POST paths; collectors cannot access other APIs", () => {
    const gate = createAuthMiddleware("dashboard-secret");
    for (const [method, path, allowed] of [
      ["POST", "/api/external-sessions/ingest", true], ["POST", "/api/external-sessions/heartbeat/", true],
      ["GET", "/api/external-sessions/ingest", false], ["POST", "/api/external-sessions/ingest/nested", false],
      ["POST", "/api/tasks", false], ["GET", "/api/external-sessions", false],
    ] as const) {
      const s = setup(); Object.assign(s.req, { method, path }); const next = vi.fn();
      gate(s.req, s.res, next);
      expect(next).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (!allowed) expect(s.status).toHaveBeenCalledWith(401);
    }
  });
});

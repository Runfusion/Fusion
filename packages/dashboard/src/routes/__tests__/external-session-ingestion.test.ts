import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { ExternalSessionStore, ExternalSessionConflict, ExternalSessionFeedback, ExternalSessionTurnStore } from "@fusion/core";
import type { ApiRoutesContext } from "../types.js";
import { registerExternalSessionRoutes } from "../register-external-session-routes.js";
import { createAuthMiddleware } from "../../auth-middleware.js";
import { parseExternalSessionCollectorCredentials } from "../external-session-collector-auth.js";

const token = randomBytes(32).toString("hex");
const credential = { projectId: "project-1", hostId: "host-1", tokenSha256: createHash("sha256").update(token).digest("hex") };
const body = { schemaVersion: 1, streamId: "spool", sequence: 1, eventId: "event-1", collectorVersion: "1.0",
  session: { provider: "other-provider", nativeSessionId: "native-1", revision: 1, activity: "waiting", observedAt: "2026-09-17T00:00:00Z" } };
const ack = { schemaVersion: 1, streamId: "spool", acknowledgedSequence: 1, sessionId: "session-id", applied: true };
type Handler = (req: Request, res: Response) => Promise<void>;

function setup(config: unknown = [credential]) {
  const handlers = new Map<string, Handler>();
  const getProjectContext = vi.fn(async () => ({ projectId: "project-1", store: { getAsyncLayer: () => ({ projectId: "project-1" }) } }));
  registerExternalSessionRoutes({ router: { get: vi.fn(), post: (path: string, handler: Handler) => handlers.set(path, handler) },
    options: { externalSessionCollectors: config, noAuth: true }, getProjectContext } as unknown as ApiRoutesContext);
  const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
  const req = { headers: { authorization: `Bearer ${token}` }, query: { projectId: "project-1" }, body } as unknown as Request;
  return { handlers, getProjectContext, req, res: res as unknown as Response, json: res.json, status: res.status };
}

beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("FUSION_EXTERNAL_SESSION_COLLECTORS", ""); });

describe("external-session ingestion registrar", () => {
  it("authenticates standalone hook claims and acknowledgements with exact host scope", async () => {
    const claim = vi.spyOn(ExternalSessionFeedback.prototype, "claim").mockResolvedValue({ command: null });
    const ackHook = vi.spyOn(ExternalSessionFeedback.prototype, "acknowledge").mockResolvedValue({ acknowledged: true });
    for (const operation of ["feedback-claim", "feedback-ack"]) {
      const s = setup(); s.req.body = { sessionId: "a".repeat(64), generation: "native-generation", ...(operation === "feedback-ack" ? { commandId: "550e8400-e29b-41d4-a716-446655440000", status: "delivered" } : {}) };
      await s.handlers.get(`/external-sessions/${operation}`)!(s.req, s.res);
      expect(operation === "feedback-claim" ? claim : ackHook).toHaveBeenCalledWith("host-1", s.req.body);
      s.req.headers.authorization = undefined; s.getProjectContext.mockClear();
      await expect(s.handlers.get(`/external-sessions/${operation}`)!(s.req, s.res)).rejects.toMatchObject({ statusCode: 401 });
      expect(s.getProjectContext).not.toHaveBeenCalled();
    }
  });
  it("authenticates the host/project credential before resolving storage and returns a committed ack", async () => {
    const ingest = vi.spyOn(ExternalSessionStore.prototype, "ingest").mockResolvedValue(ack as Awaited<ReturnType<ExternalSessionStore["ingest"]>>);
    const s = setup();
    await s.handlers.get("/external-sessions/ingest")!(s.req, s.res);
    // Ingest now also receives the rate stamp for this revision's usage increment (F1 = 3).
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 1, session: expect.objectContaining({ provider: "other-provider" }) }),
      undefined,
    );
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

  it("authenticates and acknowledges bounded turn ingestion", async () => {
    const result = { schemaVersion: 1 as const, eventId: "turn-event", sessionId: "a".repeat(64), nativeTurnId: "turn-1", revision: 1, applied: true };
    const ingest = vi.spyOn(ExternalSessionTurnStore.prototype, "ingest").mockResolvedValue(result);
    const s = setup(); s.req.body = { schemaVersion: 1, eventId: "turn-event", sessionId: "a".repeat(64),
      turn: { nativeTurnId: "turn-1", revision: 1, ordinal: 0, state: "completed",
        prompts: [{ at: null, text: "Fix it" }], response: "Done", startedAt: null, endedAt: null,
        durationMs: null, durationSource: null, toolCallCount: 1, fileChanges: [] } };
    await s.handlers.get("/external-sessions/turn-ingest")!(s.req, s.res);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "a".repeat(64), turn: expect.objectContaining({ nativeTurnId: "turn-1" }) }));
    expect(s.json).toHaveBeenCalledWith(result);
  });

  it("discards a collector-supplied pricing stamp so a host cannot price its own work", async () => {
    const result = { schemaVersion: 1 as const, eventId: "turn-event", sessionId: "a".repeat(64), nativeTurnId: "turn-1", revision: 1, applied: true };
    const ingest = vi.spyOn(ExternalSessionTurnStore.prototype, "ingest").mockResolvedValue(result);
    const forged = { asOf: "1999-01-01", source: "forged", rates: { "claude_code:x": { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0, source: "forged" } } };
    const s = setup(); s.req.body = { schemaVersion: 1, eventId: "turn-event", sessionId: "a".repeat(64),
      turn: { nativeTurnId: "turn-1", revision: 1, ordinal: 0, state: "completed",
        prompts: [{ at: null, text: "Fix it" }], response: "Done", startedAt: null, endedAt: null,
        durationMs: null, durationSource: null, toolCallCount: 1, fileChanges: [], pricing: forged } };
    await s.handlers.get("/external-sessions/turn-ingest")!(s.req, s.res);
    const sent = ingest.mock.calls[0]![0] as { turn: { pricing?: unknown } };
    // The stamp is server-computed; a zero-rate stamp from a host would otherwise make its work look free.
    expect(sent.turn.pricing).not.toEqual(forged);
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
    vi.stubEnv("FUSION_EXTERNAL_SESSION_COLLECTORS", undefined);
    const disabled = setup(undefined);
    const handlers = new Map<string, Handler>();
    registerExternalSessionRoutes({ router: { get: vi.fn(), post: (path: string, handler: Handler) => handlers.set(path, handler) }, options: {} } as unknown as ApiRoutesContext);
    await expect(handlers.get("/external-sessions/ingest")!(disabled.req, disabled.res)).rejects.toMatchObject({ statusCode: 404 });
    vi.stubEnv("FUSION_EXTERNAL_SESSION_COLLECTORS", JSON.stringify([credential]));
    vi.spyOn(ExternalSessionStore.prototype, "ingest").mockResolvedValue(ack as Awaited<ReturnType<ExternalSessionStore["ingest"]>>);
    const env = setup(null);
    registerExternalSessionRoutes({ router: { get: vi.fn(), post: (path: string, handler: Handler) => env.handlers.set(path, handler) }, getProjectContext: env.getProjectContext } as unknown as ApiRoutesContext);
    await env.handlers.get("/external-sessions/ingest")!(env.req, env.res);
    expect(env.json).toHaveBeenCalledWith(ack);
  });

  it("refuses a project resolver/storage mismatch instead of falling back to another project", async () => {
    const s = setup();
    s.getProjectContext.mockResolvedValue({ projectId: "other", store: { getAsyncLayer: () => ({ projectId: "other" }) } });
    await expect(s.handlers.get("/external-sessions/ingest")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 503 });
    expect(s.json).not.toHaveBeenCalled();
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
      ["POST", "/api/external-sessions/turn-ingest", true],
      ["POST", "/api/external-sessions/feedback-claim", true], ["POST", "/api/external-sessions/feedback-ack/", true],
      ["GET", "/api/external-sessions/feedback-claim", false], ["POST", "/api/external-sessions/feedback-ack/nested", false],
      ["POST", "/api/external-sessions/" + "a".repeat(64) + "/feedback", false],
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

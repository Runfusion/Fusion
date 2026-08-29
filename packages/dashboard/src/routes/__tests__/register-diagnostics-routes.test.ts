// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request as performRequest } from "../../test-request.js";
import {
  __resetResumeDiagnosticsForTests,
  __setResumeDiagnosticsCapForTests,
  registerDiagnosticsRoutes,
} from "../register-diagnostics-routes.js";

function createApp(getProjectContext = vi.fn(async () => ({ projectId: "proj-1", store: {} }))) {
  const router = express.Router();
  const rethrowAsApiError = vi.fn((error: unknown) => {
    throw error;
  });

  registerDiagnosticsRoutes({
    router,
    store: {} as never,
    runtimeLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
    planningLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
    chatLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
    getProjectIdFromRequest: vi.fn(() => "proj-1"),
    getScopedStore: vi.fn(async () => ({}) as never),
    getProjectContext,
    prioritizeProjectsForCurrentDirectory: vi.fn((projects: Array<{ path: string }>) => projects),
    emitRemoteRouteDiagnostic: vi.fn(),
    emitAuthSyncAuditLog: vi.fn(),
    parseScopeParam: vi.fn(),
    resolveAutomationStore: vi.fn() as never,
    resolveRoutineStore: vi.fn() as never,
    resolveRoutineRunner: vi.fn() as never,
    registerDispose: vi.fn(),
    dispose: vi.fn(),
    rethrowAsApiError,
  });

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? String(err) });
  });

  return { app, getProjectContext, rethrowAsApiError };
}

const validEvent = {
  ts: "2026-05-20T12:00:00.000Z",
  view: "useTasks",
  trigger: "visibility",
  replayAttempted: false,
  detail: { reason: "debounced-refresh" },
};

describe("register-diagnostics-routes", () => {
  beforeEach(() => {
    __resetResumeDiagnosticsForTests();
  });

  it("accepts valid POST payload", async () => {
    const { app } = createApp();
    const response = await performRequest(
      app,
      "POST",
      "/api/diagnostics/resume-events",
      JSON.stringify({ events: [validEvent] }),
      { "Content-Type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, accepted: 1 });
  });

  it("rejects invalid payloads", async () => {
    const { app } = createApp();

    const oversized = await performRequest(
      app,
      "POST",
      "/api/diagnostics/resume-events",
      JSON.stringify({ events: new Array(101).fill(validEvent) }),
      { "Content-Type": "application/json" },
    );
    expect(oversized.status).toBe(400);

    const badTrigger = await performRequest(
      app,
      "POST",
      "/api/diagnostics/resume-events",
      JSON.stringify({ events: [{ ...validEvent, trigger: "unknown" }] }),
      { "Content-Type": "application/json" },
    );
    expect(badTrigger.status).toBe(400);

    const hugeDetail = await performRequest(
      app,
      "POST",
      "/api/diagnostics/resume-events",
      JSON.stringify({ events: [{ ...validEvent, detail: { blob: "x".repeat(5000) } }] }),
      { "Content-Type": "application/json" },
    );
    expect(hugeDetail.status).toBe(400);
  });

  it("supports GET filters by since and view", async () => {
    const { app } = createApp();
    await performRequest(
      app,
      "POST",
      "/api/diagnostics/resume-events",
      JSON.stringify({
        events: [
          validEvent,
          { ...validEvent, ts: "2026-05-20T12:10:00.000Z", view: "useChatRooms", trigger: "sse-reconnect" },
        ],
      }),
      { "Content-Type": "application/json" },
    );

    const response = await performRequest(app, "GET", "/api/diagnostics/resume-events?since=2026-05-20T12:05:00.000Z&view=useChatRooms");

    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    expect(response.body.events[0]).toMatchObject({ view: "useChatRooms" });
  });

  it("tracks ring overflow and returns droppedSinceLastRead", async () => {
    const { app } = createApp();
    __setResumeDiagnosticsCapForTests(200);

    const chunk = new Array(100).fill(null).map((_, idx) => ({
      ...validEvent,
      ts: new Date(Date.UTC(2026, 4, 20, 12, 0, 0, idx)).toISOString(),
      detail: { idx },
    }));

    for (let i = 0; i < 3; i += 1) {
      await performRequest(
        app,
        "POST",
        "/api/diagnostics/resume-events",
        JSON.stringify({ events: chunk }),
        { "Content-Type": "application/json" },
      );
    }

    const response = await performRequest(app, "GET", "/api/diagnostics/resume-events?limit=5000");
    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(200);
    expect(response.body.droppedSinceLastRead).toBe(100);

    const secondRead = await performRequest(app, "GET", "/api/diagnostics/resume-events?limit=1");
    expect(secondRead.body.droppedSinceLastRead).toBe(0);
  });

  it("uses getProjectContext / rethrow flow on auth errors", async () => {
    const getProjectContext = vi.fn(async () => {
      throw new Error("unauthorized");
    });
    const { app, rethrowAsApiError } = createApp(getProjectContext);

    const response = await performRequest(app, "GET", "/api/diagnostics/resume-events");

    expect(response.status).toBe(500);
    expect(rethrowAsApiError).toHaveBeenCalled();
  });
});

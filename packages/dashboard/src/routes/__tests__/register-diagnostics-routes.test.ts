// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request as performRequest } from "../../test-request.js";
import { RESUME_TRIGGERS } from "../../shared/resume-triggers.js";
import {
  __resetResumeDiagnosticsForTests,
  __setResumeDiagnosticsCapForTests,
  registerDiagnosticsRoutes,
} from "../register-diagnostics-routes.js";

function createApp(getProjectContext = vi.fn(async () => ({ projectId: "proj-1", store: {} })), store: unknown = {}) {
  const router = express.Router();
  const rethrowAsApiError = vi.fn((error: unknown) => {
    throw error;
  });

  registerDiagnosticsRoutes({
    router,
    store: store as never,
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

  it.each(RESUME_TRIGGERS)("accepts the shared %s resume trigger", async (trigger) => {
    const { app } = createApp();
    const response = await performRequest(
      app,
      "POST",
      "/api/diagnostics/resume-events",
      JSON.stringify({ events: [{ ...validEvent, trigger }] }),
      { "Content-Type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, accepted: 1 });
  });

  it("accepts focus, the tab-return trigger reported by operators", async () => {
    const { app } = createApp();
    const response = await performRequest(
      app,
      "POST",
      "/api/diagnostics/resume-events",
      JSON.stringify({ events: [{ ...validEvent, trigger: "focus" }] }),
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

    const mixedTriggerBatch = await performRequest(
      app,
      "POST",
      "/api/diagnostics/resume-events",
      JSON.stringify({ events: [validEvent, { ...validEvent, trigger: "unknown" }] }),
      { "Content-Type": "application/json" },
    );
    expect(mixedTriggerBatch.status).toBe(400);
    expect(mixedTriggerBatch.body).toEqual({ error: "Invalid resume event entry" });

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

  /*
  FNXC:RunAuditSink 2026-09-30 (RUFU-453):
  The sink is only worth having if its accounting is readable, so these cases pin the two answers an
  operator distinguishes: a host with no drain writer must say `available: false` while still reporting
  whether the kill switch is the reason, and a live writer must expose the full accounting plus the
  spill file's size without ever parsing the backup unless `?rows=1` asks for the rows.
  */
  it("reports the run-audit sink when no drain writer exists", async () => {
    const { app } = createApp(undefined, {});

    const response = await performRequest(app, "GET", "/api/diagnostics/run-audit-sink");

    expect(response.status).toBe(200);
    expect(response.body.available).toBe(false);
    expect(typeof response.body.buffered).toBe("boolean");
    expect(response.body.pid).toBe(process.pid);
  });

  it("reports sink accounting and spill size without reading the backup", async () => {
    const readRows = vi.fn(async () => ({ path: "/tmp/x.jsonl", bytes: 10, rows: [], malformed: 0, truncated: false }));
    const { app } = createApp(undefined, {
      getRunAuditSinkStats: () => ({
        accepted: 12, coalesced: 4, written: 8, batches: 2, batchFailures: 1, queueDepth: 3, queuePeak: 9,
        timedOut: 1, lateRecorded: 2, slowWrites: 3, maxLatencyMs: 1400, spilledToDeadLetter: 1,
        deadLetterSuppressed: 0, pid: 4242,
      }),
      getRunAuditSinkDeadLetterStats: () => ({ path: "/tmp/x.jsonl", bytes: 4096, rows: 1, suppressed: 0, writeFailures: 0 }),
      readRunAuditSinkDeadLetter: readRows,
    });

    const response = await performRequest(app, "GET", "/api/diagnostics/run-audit-sink");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      available: true,
      buffered: true,
      accepted: 12,
      written: 8,
      queueDepth: 3,
      lateRecorded: 2,
      spilledToDeadLetter: 1,
      deadLetter: { path: "/tmp/x.jsonl", bytes: 4096, rows: 1 },
    });
    expect(readRows).not.toHaveBeenCalled();

    const withRows = await performRequest(app, "GET", "/api/diagnostics/run-audit-sink?rows=1");
    expect(withRows.body.deadLetter.entries).toEqual([]);
    expect(readRows).toHaveBeenCalledOnce();
  });
});

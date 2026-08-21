// @vitest-environment node
import express from "express";
import multer from "multer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryCaptureResult } from "@fusion/core";
import { request } from "../test-request.js";
import { registerChatRoutes } from "../routes/register-chat-routes.js";

/*
FNXC:ChatStashBackfill 2026-08-19-16:28:
(operator request 2026-08-19) POST /api/chat/sessions/:id/backfill-stash backfills a
chat's full message history into Stash on demand. These tests mock captureMemory AND
queryStashEvents (no real network) while keeping resolveStashMemorySettings REAL, and
assert the contract: (a) 200 {ok,inserted,skipped,uploaded} with per-message REAL
created_at timestamps, role-mapped event types, and default agent_name; (b) memory-
disabled / non-stash / unconfigured-key / empty-chat / unknown-session all 400/404
WITHOUT calling capture; (c) a captureMemory ok:false degrades to a visible 502, never
a success; (d) the global stash-api-key secret path (listSecrets → revealSecret)
threads the resolved key into the capture settings.
FNXC:ChatStashBackfillIdempotency 2026-08-19-22:35:
Stash's /events/batch is a bare INSERT (no server-side dedupe — verified against the
backend source and live: 4 -> 8 -> 12 events across two identical backfills), so
idempotency is client-side: the route pages the session's existing events via
queryStashEvents and skips already-stored events. (i) asserts a pre-check hit skips
those messages (capture receives only the fresh ones; skipped is reported); (j)
asserts a pre-check transport failure fails CLOSED (502, no capture) rather than
uploading duplicates.
FNXC:ChatStashBackfillKey 2026-08-21-13:35:
RUFU-146 review (PRRT_kwDOSA-8Y86a7RZ8): the dedupe key is now (event type,
canonical timestamp, NUL-stripped content) instead of content alone — identical
text at different times (or empty content) must not collapse onto one key, and
the wire field is created_at (the Stash field the server honors) instead of the
ignored `timestamp` key. (l) is the three-phase regression.
*/
const mocks = vi.hoisted(() => ({
  captureMemory: vi.fn(),
  queryStashEvents: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    captureMemory: mocks.captureMemory,
    queryStashEvents: mocks.queryStashEvents,
  };
});

const STASH_OK_SETTINGS = {
  memoryEnabled: true,
  memoryBackendType: "stash",
  stashUrl: "http://stash.test",
  stashApiKey: "key-123",
};

const MESSAGES = [
  {
    id: "m1",
    sessionId: "chat-abc12345",
    role: "user",
    content: "hello old chat",
    thinkingOutput: null,
    metadata: null,
    createdAt: "2026-07-01T10:00:00.000Z",
  },
  {
    id: "m2",
    sessionId: "chat-abc12345",
    role: "assistant",
    content: "old reply",
    thinkingOutput: null,
    metadata: { agent_name: "engineer" },
    createdAt: "2026-07-01T10:00:30.000Z",
  },
  {
    id: "m3",
    sessionId: "chat-abc12345",
    role: "user",
    content: "follow-up",
    thinkingOutput: null,
    metadata: null,
    createdAt: "2026-07-02T09:00:00.000Z",
  },
  {
    id: "m4",
    sessionId: "chat-abc12345",
    role: "assistant",
    content: "second reply",
    thinkingOutput: null,
    metadata: null,
    createdAt: "2026-07-02T09:00:45.000Z",
  },
];

interface BuildOpts {
  settings?: Record<string, unknown>;
  sessionExists?: boolean;
  messages?: Array<Record<string, unknown>>;
  getSecretsStore?: () => Promise<unknown> | undefined;
  captureResult?: MemoryCaptureResult;
}

function buildApp(opts: BuildOpts) {
  const chatStore = {
    getSession: async (id: string) => (opts.sessionExists === false ? null : id ? { id, title: "Test chat" } : null),
    getMessages: async (_sessionId: string) => (opts.messages ?? MESSAGES) as never,
  };
  const scopedStore = {
    getFusionDir: () => "/route-project/.fusion",
    getRootDir: () => "/route-project",
    getProjectId: () => "project-1",
    getSettings: async () => opts.settings,
    ...(opts.getSecretsStore ? { getSecretsStore: opts.getSecretsStore } : {}),
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerChatRoutes(
    {
      router,
      store: scopedStore,
      options: { chatStore },
      getProjectContext: async () => ({ store: scopedStore, projectId: "project-1", engine: undefined }),
      rethrowAsApiError: (error: unknown) => {
        throw error;
      },
    } as never,
    {
      parseLastEventId: () => undefined,
      replayBufferedSSE: () => false,
      validateOptionalModelField: () => undefined,
      upload: multer(),
    },
  );
  app.use("/api", router);
  app.use(
    (err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err?.statusCode ?? 500).json({ error: err?.message ?? "unknown" });
    },
  );
  return { app };
}

describe("POST /api/chat/sessions/:id/backfill-stash (ChatStashBackfill)", () => {
  beforeEach(() => {
    // The happy-path defaults must exist BEFORE the first test — vi.fn() has no
    // implementation until the first afterEach would set one, so test (a) (first to
    // run) would otherwise receive undefined and 500 on `result.ok`. Same applies to
    // the queryStashEvents pre-check: an empty existing-events set is the fresh-chat
    // default (nothing stored yet -> nothing skipped).
    mocks.captureMemory.mockResolvedValue({ ok: true, inserted: 2, deduped: 1 });
    mocks.queryStashEvents.mockResolvedValue({ events: [], hasMore: false });
  });

  afterEach(() => {
    mocks.captureMemory.mockReset();
    mocks.queryStashEvents.mockReset();
  });

  it("(a) 200 with counts; events carry REAL created_at, role-mapped types, default agent_name", async () => {
    const { app } = buildApp({ settings: STASH_OK_SETTINGS });

    const res = await request(app, "POST", "/api/chat/sessions/chat-abc12345/backfill-stash");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 2, skipped: 0, uploaded: 4 });
    expect(mocks.queryStashEvents).toHaveBeenCalledTimes(1);
    expect(mocks.queryStashEvents.mock.calls[0][2]).toMatchObject({
      sessionId: "chat-abc12345",
      order: "asc",
      limit: 200,
    });
    expect(mocks.captureMemory).toHaveBeenCalledTimes(1);
    const [rootDir, resolved, sessionId, events, meta] = mocks.captureMemory.mock.calls[0];
    expect(rootDir).toBe("/route-project");
    expect(resolved).toMatchObject({ memoryBackendType: "stash", stashApiKey: "key-123", stashUrl: "http://stash.test" });
    expect(sessionId).toBe("chat-abc12345");
    expect(events).toHaveLength(4);
    // Role mapping mirrors chatMessageToMemoryCaptureEvent.
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "assistant_message",
    ]);
    // Real per-message chronology — NOT the upload time (a backfill that re-stamped
    // every message with now() would destroy the transcript's after/before ordering).
    expect(events.map((e: { created_at: string }) => e.created_at)).toEqual([
      "2026-07-01T10:00:00.000Z",
      "2026-07-01T10:00:30.000Z",
      "2026-07-02T09:00:00.000Z",
      "2026-07-02T09:00:45.000Z",
    ]);
    // agent_name from metadata when present, "fusion" otherwise.
    expect(events.map((e: { agent_name: string }) => e.agent_name)).toEqual(["fusion", "engineer", "fusion", "fusion"]);
    expect(events.map((e: { content: string }) => e.content)).toEqual(["hello old chat", "old reply", "follow-up", "second reply"]);
    // RUFU-121 identity forwarding: folder resolution + Stash title generation.
    expect(meta).toEqual({ projectRoot: "/route-project", projectId: "project-1", chatTitle: "Test chat" });
  });

  it("(b) memory disabled -> 400, capture never called", async () => {
    const { app } = buildApp({
      settings: { memoryEnabled: false, memoryBackendType: "stash", stashUrl: "http://stash.test", stashApiKey: "key-123" },
    });
    const res = await request(app, "POST", "/api/chat/sessions/chat-abc12345/backfill-stash");
    expect(res.status).toBe(400);
    expect(mocks.captureMemory).not.toHaveBeenCalled();
  });

  it("(c) non-stash backend -> 400, capture never called", async () => {
    const { app } = buildApp({
      settings: { memoryEnabled: true, memoryBackendType: "file", stashUrl: "http://stash.test", stashApiKey: "key-123" },
    });
    const res = await request(app, "POST", "/api/chat/sessions/chat-abc12345/backfill-stash");
    expect(res.status).toBe(400);
    expect(mocks.captureMemory).not.toHaveBeenCalled();
  });

  it("(d) stash backend with missing key (no settings key, no secret) -> 400, capture never called", async () => {
    const { app } = buildApp({ settings: { memoryEnabled: true, memoryBackendType: "stash", stashUrl: "http://stash.test" } });
    const res = await request(app, "POST", "/api/chat/sessions/chat-abc12345/backfill-stash");
    expect(res.status).toBe(400);
    expect(mocks.captureMemory).not.toHaveBeenCalled();
  });

  it("(e) unknown session -> 404, capture never called", async () => {
    const { app } = buildApp({ settings: STASH_OK_SETTINGS, sessionExists: false });
    const res = await request(app, "POST", "/api/chat/sessions/chat-missing/backfill-stash");
    expect(res.status).toBe(404);
    expect(mocks.captureMemory).not.toHaveBeenCalled();
  });

  it("(f) empty chat -> 400, capture never called", async () => {
    const { app } = buildApp({ settings: STASH_OK_SETTINGS, messages: [] });
    const res = await request(app, "POST", "/api/chat/sessions/chat-abc12345/backfill-stash");
    expect(res.status).toBe(400);
    expect(mocks.captureMemory).not.toHaveBeenCalled();
  });

  it("(g) captureMemory ok:false -> visible 502, never reported as success", async () => {
    const { app } = buildApp({ settings: STASH_OK_SETTINGS });
    mocks.captureMemory.mockResolvedValue({ ok: false, inserted: 0, deduped: 0 });

    const res = await request(app, "POST", "/api/chat/sessions/chat-abc12345/backfill-stash");

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.uploaded).toBe(4);
    expect(res.body.skipped).toBe(0);
    expect(res.body.error).toContain("Stash upload failed");
  });

  /*
  FNXC:ChatStashBackfillIdempotency 2026-08-19-22:35:
  (i) The pre-check found two of the four message contents already stored in Stash
  (a re-run, or a chat that was partially live-captured): those two are skipped and
  only the fresh two reach captureMemory. The response reports skipped:2 so the UI
  toast can say "2 already stored" instead of a misleading insert count.
  (j) A pre-check transport failure (Stash unreachable during the read) must fail
  CLOSED — 502 with a pre-check error, and captureMemory never called. Blindly
  uploading without the pre-check would insert duplicates (Stash has no server-side
  dedupe), so the read failure must block the write.
  */
  it("(i) pre-check finds existing content -> those messages are skipped, only fresh ones uploaded", async () => {
    const { app } = buildApp({ settings: STASH_OK_SETTINGS });
    mocks.queryStashEvents.mockResolvedValue({
      events: [
        { event_type: "user_message", content: "hello old chat", created_at: "2026-07-01T10:00:00.000Z" },
        { event_type: "assistant_message", content: "old reply", created_at: "2026-07-01T10:00:30.000Z" },
      ],
      hasMore: false,
    });

    const res = await request(app, "POST", "/api/chat/sessions/chat-abc12345/backfill-stash");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 2, skipped: 2, uploaded: 2 });
    expect(mocks.captureMemory).toHaveBeenCalledTimes(1);
    const [, , , events] = mocks.captureMemory.mock.calls[0];
    expect(events).toHaveLength(2);
    expect(events.map((e: { content: string }) => e.content)).toEqual(["follow-up", "second reply"]);
  });

  it("(j) pre-check transport failure -> 502, capture never called (fail closed, no duplicate upload)", async () => {
    const { app } = buildApp({ settings: STASH_OK_SETTINGS });
    mocks.queryStashEvents.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(app, "POST", "/api/chat/sessions/chat-abc12345/backfill-stash");

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("Stash pre-check failed");
    expect(mocks.captureMemory).not.toHaveBeenCalled();
  });

  /*
  FNXC:ChatStashBackfill 2026-08-19-16:28:
  The operator's live default sets memoryBackendType=stash WITHOUT a settings-level
  key — the key arrives from the global stash-api-key secret via listSecrets →
  revealSecret (the real, unmocked resolveStashMemorySettings). The resolved key must
  reach captureMemory or every backfill would 401 upstream and degrade to ok:false.
  */
  it("(h) key resolved from the global secret -> captureMemory receives the resolved key", async () => {
    const { app } = buildApp({
      settings: { memoryEnabled: true, memoryBackendType: "stash" },
      getSecretsStore: async () => ({
        listSecrets: async () => [{ id: "secret-row-uuid-1", key: "stash-api-key" }],
        revealSecret: async () => ({ plaintextValue: "secret-key-999" }),
      }),
    });

    const res = await request(app, "POST", "/api/chat/sessions/chat-abc12345/backfill-stash");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 2, skipped: 0, uploaded: 4 });
    const resolved = mocks.captureMemory.mock.calls[0][1];
    expect(resolved.stashApiKey).toBe("secret-key-999");
  });

  /*
  FNXC:ChatStashBackfillIdempotency 2026-08-19-22:35:
  Fully backfilled chat (every message content already in Stash): the route is a
  success no-op — nothing uploaded, nothing inserted, nothing captured. This is the
  re-run contract the changeset promises: re-running "Preserve to Stash" after a
  successful backfill must not create duplicate rows.
  */
  it("(k) all content already stored -> idempotent no-op success, capture never called", async () => {
    const { app } = buildApp({ settings: STASH_OK_SETTINGS });
    mocks.queryStashEvents.mockResolvedValue({
      events: [
        { event_type: "user_message", content: "hello old chat", created_at: "2026-07-01T10:00:00.000Z" },
        { event_type: "assistant_message", content: "old reply", created_at: "2026-07-01T10:00:30.000Z" },
        { event_type: "user_message", content: "follow-up", created_at: "2026-07-02T09:00:00.000Z" },
        { event_type: "assistant_message", content: "second reply", created_at: "2026-07-02T09:00:45.000Z" },
      ],
      hasMore: false,
    });

    const res = await request(app, "POST", "/api/chat/sessions/chat-abc12345/backfill-stash");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 0, skipped: 4, uploaded: 0 });
    expect(mocks.captureMemory).not.toHaveBeenCalled();
  });

  /*
  FNXC:ChatStashBackfillKey 2026-08-21-13:35:
  RUFU-146 review (PRRT_kwDOSA-8Y86a7RZ8): three-phase dedupe regression.
  Phase 1: fresh backfill of a chat whose messages include IDENTICAL content
  at different times ("done" x2) and EMPTY content at different times ("") —
  the content-only key collapsed all of these onto one key, permanently
  suppressing every message after the first. All four must upload.
  Phase 2: a re-run where only the FIRST "done" is stored: the second
  identical-content message must still upload (type+timestamp distinguish
  them); the two empty-content messages are not yet stored so they upload.
  Phase 3: a full re-run where all four are stored, with created_at in the
  SERVER'S re-serialized form (6-digit fraction: .000Z read back as
  .000000Z) — nothing may upload; capture is never called.
  */
  it("(l) RUFU-146: identical + empty content are distinct keys; full re-run uploads nothing", async () => {
    const dupMessages = [
      { id: "d1", sessionId: "chat-dup", role: "user", content: "done", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T10:00:00.000Z" },
      { id: "d2", sessionId: "chat-dup", role: "assistant", content: "done", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T10:00:30.000Z" },
      { id: "d3", sessionId: "chat-dup", role: "user", content: "", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T10:01:00.000Z" },
      { id: "d4", sessionId: "chat-dup", role: "assistant", content: "", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T10:02:00.000Z" },
    ];
    const { app } = buildApp({ settings: STASH_OK_SETTINGS, messages: dupMessages as never });

    // Phase 1 — fresh: store is empty, all four upload (identical/empty content included).
    mocks.queryStashEvents
      .mockResolvedValueOnce({ events: [], hasMore: false })
      // Phase 2 — only the first "done" is stored; the second must still upload.
      .mockResolvedValueOnce({
        events: [{ event_type: "user_message", content: "done", created_at: "2026-07-01T10:00:00.000Z" }],
        hasMore: false,
      })
      // Phase 3 — full re-run; the server re-serializes created_at with a 6-digit
      // fraction (.000Z -> .000000Z), so matching must survive re-serialization.
      .mockResolvedValueOnce({
        events: [
          { event_type: "user_message", content: "done", created_at: "2026-07-01T10:00:00.000000Z" },
          { event_type: "assistant_message", content: "done", created_at: "2026-07-01T10:00:30.000000Z" },
          { event_type: "user_message", content: "", created_at: "2026-07-01T10:01:00.000000Z" },
          { event_type: "assistant_message", content: "", created_at: "2026-07-01T10:02:00.000000Z" },
        ],
        hasMore: false,
      });

    const res1 = await request(app, "POST", "/api/chat/sessions/chat-dup/backfill-stash");
    expect(res1.status).toBe(200);
    expect(res1.body).toEqual({ ok: true, inserted: 2, skipped: 0, uploaded: 4 });
    expect(mocks.captureMemory).toHaveBeenCalledTimes(1);
    let [, , , events] = mocks.captureMemory.mock.calls[0];
    expect(events.map((e: { content: string }) => e.content)).toEqual(["done", "done", "", ""]);
    expect(events.map((e: { created_at: string }) => e.created_at)).toEqual([
      "2026-07-01T10:00:00.000Z",
      "2026-07-01T10:00:30.000Z",
      "2026-07-01T10:01:00.000Z",
      "2026-07-01T10:02:00.000Z",
    ]);

    const res2 = await request(app, "POST", "/api/chat/sessions/chat-dup/backfill-stash");
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual({ ok: true, inserted: 2, skipped: 1, uploaded: 3 });
    expect(mocks.captureMemory).toHaveBeenCalledTimes(2);
    [, , , events] = mocks.captureMemory.mock.calls[1];
    expect(events.map((e: { content: string }) => e.content)).toEqual(["done", "", ""]);

    const res3 = await request(app, "POST", "/api/chat/sessions/chat-dup/backfill-stash");
    expect(res3.status).toBe(200);
    expect(res3.body).toEqual({ ok: true, inserted: 0, skipped: 4, uploaded: 0 });
    expect(mocks.captureMemory).toHaveBeenCalledTimes(2); // phase 3 uploads nothing
  });
});

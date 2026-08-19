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
chat's full message history into Stash on demand. These tests mock captureMemory (no
real network) while keeping resolveStashMemorySettings REAL, and assert the contract:
(a) 200 {ok,inserted,deduped,uploaded} with per-message REAL created_at timestamps,
role-mapped event types, and default agent_name; (b) memory-disabled / non-stash /
unconfigured-key / empty-chat / unknown-session all 400/404 WITHOUT calling capture;
(c) a captureMemory ok:false degrades to a visible 502, never a success; (d) the
global stash-api-key secret path (listSecrets → revealSecret) threads the resolved key
into the capture settings.
*/
const mocks = vi.hoisted(() => ({
  captureMemory: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    captureMemory: mocks.captureMemory,
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
    // The happy-path default must exist BEFORE the first test — vi.fn() has no
    // implementation until the first afterEach would set one, so test (a) (first to
    // run) would otherwise receive undefined and 500 on `result.ok`.
    mocks.captureMemory.mockResolvedValue({ ok: true, inserted: 2, deduped: 1 });
  });

  afterEach(() => {
    mocks.captureMemory.mockReset();
  });

  it("(a) 200 with counts; events carry REAL created_at, role-mapped types, default agent_name", async () => {
    const { app } = buildApp({ settings: STASH_OK_SETTINGS });

    const res = await request(app, "POST", "/api/chat/sessions/chat-abc12345/backfill-stash");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 2, deduped: 1, uploaded: 4 });
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
    expect(events.map((e: { timestamp: string }) => e.timestamp)).toEqual([
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
    expect(res.body.error).toContain("Stash upload failed");
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
    expect(res.body).toEqual({ ok: true, inserted: 2, deduped: 1, uploaded: 4 });
    const resolved = mocks.captureMemory.mock.calls[0][1];
    expect(resolved.stashApiKey).toBe("secret-key-999");
  });
});

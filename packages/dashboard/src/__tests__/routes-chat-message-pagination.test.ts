// @vitest-environment node

import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@fusion/core";
import { request } from "../test-request.js";
import { registerChatRoutes } from "../routes/register-chat-routes.js";

function buildApp() {
  const session: ChatSession = {
    id: "session-1",
    agentId: "agent-1",
    title: "Pagination",
    status: "active",
    projectId: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    pinnedAt: null,
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  };
  const chatStore = {
    getSession: vi.fn(async () => session),
    getMessages: vi.fn(async () => []),
    getRootDir: () => "/tmp/fn-chat-pagination-route",
    getFusionDir: () => "/tmp/fn-chat-pagination-route/.fusion",
  };
  const app = express();
  const router = express.Router();
  registerChatRoutes({
    router,
    store: chatStore,
    options: { chatStore },
    getProjectContext: async () => ({ store: chatStore, projectId: null, engine: undefined }),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never, {
    parseLastEventId: () => undefined,
    replayBufferedSSE: () => false,
    validateOptionalModelField: () => undefined,
    upload: {
      array: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
      single: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    },
  });
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  return { app, chatStore };
}

/*
FNXC:ChatMessagePagination 2026-09-06-13:40:
The HTTP boundary accepts a strict `(before, beforeId)` cursor only as a pair. This keeps same-timestamp history loss impossible for paginated transcript hosts while preserving date-only compatibility for existing readers.
*/
describe("GET /api/chat/sessions/:id/messages pagination", () => {
  it("transmits the strict tuple cursor", async () => {
    const { app, chatStore } = buildApp();
    const response = await request(app, "GET", "/api/chat/sessions/session-1/messages?limit=50&order=desc&before=2026-09-06T12%3A00%3A00.000Z&beforeId=msg-050");

    expect(response.status).toBe(200);
    expect(chatStore.getMessages).toHaveBeenCalledWith("session-1", {
      limit: 50,
      offset: 0,
      before: "2026-09-06T12:00:00.000Z",
      beforeId: "msg-050",
      order: "desc",
    });
  });

  it("rejects beforeId without before", async () => {
    const { app, chatStore } = buildApp();
    const response = await request(app, "GET", "/api/chat/sessions/session-1/messages?beforeId=msg-050");

    expect(response.status).toBe(400);
    expect(chatStore.getMessages).not.toHaveBeenCalled();
  });
});

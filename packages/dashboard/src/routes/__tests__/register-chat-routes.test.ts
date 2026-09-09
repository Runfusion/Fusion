// @vitest-environment node

import express from "express";
import multer from "multer";
import { describe, expect, it, vi } from "vitest";
import { registerChatRoutes } from "../register-chat-routes.js";
import { request } from "../../test-request.js";

function makeApp() {
  const sessions = [{
    id: "chat-1", agentId: "agent-1", tags: [], title: "First", status: "active", projectId: "project-a",
    modelProvider: null, modelId: null, thinkingLevel: null, memoryFocus: null, createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z", pinnedAt: null, cliSessionFile: null, cliExecutorAdapterId: null, inFlightGeneration: null,
  }];
  const listSessionsPage = vi.fn(async () => ({ sessions, total: 2, hasMore: true, nextCursor: "next" }));
  const chatStore = {
    listSessionsPage,
    getLastMessageForSessions: vi.fn(async () => new Map()),
    searchSessionsByMessageContent: vi.fn(async () => new Map()),
  };
  const store = {
    getSettings: vi.fn(async () => ({ showTaskChatsInCommonFeed: false })),
    getFusionDir: () => "/route-project/.fusion",
    getAsyncLayer: () => undefined,
  };
  const app = express();
  const router = express.Router();
  registerChatRoutes({
    router,
    store,
    options: { chatStore },
    getProjectContext: async () => ({ store, projectId: "project-a", engine: undefined }),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never, { parseLastEventId: () => undefined, replayBufferedSSE: () => false, validateOptionalModelField: (value: unknown) => value as string | undefined, upload: multer() });
  app.use("/api", router);
  app.use((error: { statusCode?: number; status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? error.status ?? 500).json({ error: error.message }));
  return { app, listSessionsPage };
}

describe("GET /api/chat/sessions pagination", () => {
  it("returns bounded page metadata and forwards filters before enrichment", async () => {
    const { app, listSessionsPage } = makeApp();
    const response = await request(app, "GET", "/api/chat/sessions?projectId=project-a&status=active&limit=25&cursor=opaque&tagId=tag-a&q=needle");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 2, hasMore: true, nextCursor: "next" });
    expect(response.body.sessions).toHaveLength(1);
    expect(listSessionsPage).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-a", status: "active", limit: 25, cursor: "opaque", tagId: "tag-a", q: "needle" }));
  });

  it.each(["limit=0", "limit=201", "limit=nope", "status=deleted"])("rejects invalid list input without querying: %s", async (query) => {
    const { app, listSessionsPage } = makeApp();
    const response = await request(app, "GET", `/api/chat/sessions?${query}`);
    expect(response.status).toBe(400);
    expect(listSessionsPage).not.toHaveBeenCalled();
  });
});

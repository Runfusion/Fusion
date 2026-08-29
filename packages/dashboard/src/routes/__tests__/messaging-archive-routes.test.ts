// @vitest-environment node

import express from "express";
import { DASHBOARD_USER_ID, type Message, type TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { ApiError } from "../../api-error.js";
import { registerMessagingScriptRoutes } from "../register-messaging-scripts.js";
import type { ApiRoutesContext } from "../types.js";

function message(archived = false): Message {
  return {
    id: "message-archive", fromId: "agent-1", fromType: "agent", toId: DASHBOARD_USER_ID, toType: "user",
    content: "Archive me", type: "agent-to-user", read: false, archived, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

function setup() {
  const app = express();
  app.use(express.json());
  let current: Message | undefined = message();
  const messageStore = {
    archiveMessage: vi.fn(async (id: string) => {
      if (id !== current?.id) throw new Error(`Message ${id} not found`);
      current = { ...current, archived: true };
      return current;
    }),
    unarchiveMessage: vi.fn(async (id: string) => {
      if (id !== current?.id) throw new Error(`Message ${id} not found`);
      current = { ...current, archived: false };
      return current;
    }),
    deleteMessage: vi.fn(async (id: string) => {
      if (id !== current?.id) throw new Error(`Message ${id} not found`);
      current = undefined;
    }),
    getInbox: vi.fn(async (_id: string, _type: string, filter: { archived?: boolean }) =>
      current && current.archived === (filter.archived === true) ? [current] : []),
    getMailbox: vi.fn(async () => ({ unreadCount: current && !current.archived && !current.read ? 1 : 0 })),
  };
  const store = { getRootDir: () => "/test" } as unknown as TaskStore;
  const context = {
    router: express.Router(), store,
    getProjectContext: async () => ({ store, engine: { getMessageStore: () => messageStore }, projectId: undefined }),
    rethrowAsApiError: (error: unknown): never => { throw error; }, runtimeLogger: { warn: vi.fn() }, planningLogger: {}, chatLogger: {},
  } as unknown as ApiRoutesContext;
  registerMessagingScriptRoutes(context);
  app.use("/api", context.router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof ApiError ? error.statusCode : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });
  return { app, messageStore };
}

describe("messaging archive routes", () => {
  it("archives, filters, restores, and excludes archive mail from unread counts", async () => {
    const { app } = setup();

    const archived = await request(app, "POST", "/api/messages/message-archive/archive");
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);

    const inbox = await request(app, "GET", "/api/messages/inbox");
    expect(inbox.body.messages).toEqual([]);
    expect(inbox.body.unreadCount).toBe(0);

    const archivedInbox = await request(app, "GET", "/api/messages/inbox?archived=true");
    expect(archivedInbox.body.messages).toHaveLength(1);
    expect(archivedInbox.body.messages[0].id).toBe("message-archive");

    const restored = await request(app, "POST", "/api/messages/message-archive/unarchive");
    expect(restored.status).toBe(200);
    expect(restored.body.archived).toBe(false);
  });

  it("preserves hard delete as an explicit route and maps unknown archive IDs to 404", async () => {
    const { app, messageStore } = setup();
    const missing = await request(app, "POST", "/api/messages/missing/archive");
    expect(missing.status).toBe(404);

    const deleted = await request(app, "DELETE", "/api/messages/message-archive");
    expect(deleted.status).toBe(204);
    expect(messageStore.deleteMessage).toHaveBeenCalledWith("message-archive");
  });
});

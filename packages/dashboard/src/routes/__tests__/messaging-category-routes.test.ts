// @vitest-environment node

import express from "express";
import { DASHBOARD_USER_ID, type DashboardInboxCategory, type Message, type MessageFilter, type TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { ApiError } from "../../api-error.js";
import { registerMessagingScriptRoutes } from "../register-messaging-scripts.js";
import type { ApiRoutesContext } from "../types.js";

const categoryCounts: Record<DashboardInboxCategory, number> = {
  message: 1,
  recommendation: 1,
  artifact: 1,
};

function createMessages(): Message[] {
  return [
    {
      id: "message-recommendation", fromId: "system", fromType: "system", toId: DASHBOARD_USER_ID, toType: "user",
      content: "Recommendation", type: "system", read: false, archived: false, metadata: { kind: "task-recommendation-notice" },
      createdAt: "2026-09-06T00:00:03.000Z", updatedAt: "2026-09-06T00:00:03.000Z",
    },
    {
      id: "message-artifact", fromId: "system", fromType: "system", toId: DASHBOARD_USER_ID, toType: "user",
      content: "Artifact", type: "system", read: false, archived: false, metadata: { artifactId: "artifact-1" },
      createdAt: "2026-09-06T00:00:02.000Z", updatedAt: "2026-09-06T00:00:02.000Z",
    },
    {
      id: "message-ordinary", fromId: "agent-1", fromType: "agent", toId: DASHBOARD_USER_ID, toType: "user",
      content: "Ordinary", type: "agent-to-user", read: false, archived: false,
      createdAt: "2026-09-06T00:00:01.000Z", updatedAt: "2026-09-06T00:00:01.000Z",
    },
  ];
}

function setup(options?: { categoryReader?: "present" | "missing" | "failing" }) {
  const app = express();
  app.use(express.json());
  const messages = createMessages();
  const messageStore: Record<string, unknown> = {
    getInbox: vi.fn(async (_id: string, _type: string, filter: MessageFilter) =>
      filter.category === "message" ? messages.filter(({ id }) => id === "message-ordinary") : messages),
    getMailbox: vi.fn(async () => ({ unreadCount: 3 })),
    markAllAsRead: vi.fn(async () => 1),
  };
  if (options?.categoryReader !== "missing") {
    messageStore.getDashboardInboxCategoryCounts = options?.categoryReader === "failing"
      ? vi.fn(async () => { throw new Error("category counts unavailable"); })
      : vi.fn(async () => categoryCounts);
  }
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

describe("messaging category routes", () => {
  it("filters the inbox to ordinary messages and forwards the category", async () => {
    const { app, messageStore } = setup();
    const response = await request(app, "GET", "/api/messages/inbox?category=message");

    expect(response.status).toBe(200);
    expect(response.body.messages.map(({ id }: Message) => id)).toEqual(["message-ordinary"]);
    expect(messageStore.getInbox).toHaveBeenCalledWith(
      DASHBOARD_USER_ID,
      "user",
      expect.objectContaining({ category: "message" }),
    );
    expect(response.body.categoryUnreadCounts).toEqual(categoryCounts);
  });

  it("preserves the total unread count and adds category counts", async () => {
    const { app } = setup();
    const response = await request(app, "GET", "/api/messages/unread-count");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ unreadCount: 3, categoryUnreadCounts: categoryCounts });
  });

  it("scopes mark-all-read when requested and preserves the body-less call", async () => {
    const { app, messageStore } = setup();
    const scoped = await request(
      app,
      "POST",
      "/api/messages/read-all",
      JSON.stringify({ category: "artifact" }),
      { "content-type": "application/json" },
    );
    expect(scoped.status).toBe(200);
    expect(messageStore.markAllAsRead).toHaveBeenLastCalledWith(DASHBOARD_USER_ID, "user", "artifact");

    const historical = await request(app, "POST", "/api/messages/read-all");
    expect(historical.status).toBe(200);
    expect(messageStore.markAllAsRead).toHaveBeenLastCalledWith(DASHBOARD_USER_ID, "user");
  });

  it("ignores an unknown category instead of failing the inbox", async () => {
    const { app, messageStore } = setup();
    const response = await request(app, "GET", "/api/messages/inbox?category=unknown");

    expect(response.status).toBe(200);
    expect(response.body.messages).toHaveLength(3);
    expect(messageStore.getInbox).toHaveBeenCalledWith(
      DASHBOARD_USER_ID,
      "user",
      expect.not.objectContaining({ category: expect.anything() }),
    );
  });

  it.each(["missing", "failing"] as const)("keeps routes available when the category reader is %s", async (categoryReader) => {
    const { app } = setup({ categoryReader });
    const response = await request(app, "GET", "/api/messages/unread-count");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ unreadCount: 3 });
    expect(response.body).not.toHaveProperty("categoryUnreadCounts");
  });
});

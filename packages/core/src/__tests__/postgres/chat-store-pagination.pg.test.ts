import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { createChatSession, decodeChatSessionCursor, listChatSessionsPage } from "../../async-stores/async-chat-store.js";
import * as schema from "../../postgres/schema/index.js";
import type { ChatSession } from "../../chat/chat-types.js";

pgDescribe("ChatStore session cursor pagination", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_chat_page" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("walks 1,000 equal-timestamp sessions exactly once with bounded pages", async () => {
    const timestamp = "2026-09-07T12:00:00.000Z";
    const rows = Array.from({ length: 1_000 }, (_, index) => ({
      id: `chat-page-${String(index).padStart(4, "0")}`,
      agentId: index % 2 ? "agent-odd" : "agent-even",
      title: `Session ${index}`,
      status: "active" as const,
      projectId: null,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      memoryFocus: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      pinnedAt: index < 3 ? `2026-09-07T13:00:0${index}.000Z` : null,
      cliSessionFile: null,
      inFlightGeneration: null,
      cliExecutorAdapterId: null,
      tags: [],
    } satisfies ChatSession));
    for (let index = 0; index < rows.length; index += 100) {
      await Promise.all(rows.slice(index, index + 100).map((row) => createChatSession(h.layer().db, row)));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listChatSessionsPage(h.layer().db, { limit: 73, cursor });
      expect(page.sessions.length).toBeLessThanOrEqual(73);
      expect(page.total).toBe(1_000);
      seen.push(...page.sessions.map((session) => session.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toHaveLength(1_000);
    expect(new Set(seen).size).toBe(1_000);
    expect(seen.slice(0, 3)).toEqual(["chat-page-0002", "chat-page-0001", "chat-page-0000"]);
  });

  it("keeps an exclusive cursor stable across insertion and rejects malformed cursors", async () => {
    const make = async (id: string, updatedAt: string, title = id) => createChatSession(h.layer().db, {
      id, agentId: "agent", title, status: "active", projectId: null, modelProvider: null, modelId: null,
      thinkingLevel: null, memoryFocus: null, createdAt: updatedAt, updatedAt, pinnedAt: null,
      cliSessionFile: null, inFlightGeneration: null, cliExecutorAdapterId: null, tags: [],
    });
    await make("chat-c", "2026-09-07T03:00:00.000Z", "needle c");
    await make("chat-b", "2026-09-07T02:00:00.000Z", "needle b");
    await make("chat-a", "2026-09-07T01:00:00.000Z", "other");
    const first = await listChatSessionsPage(h.layer().db, { limit: 2 });
    await make("chat-new", "2026-09-07T04:00:00.000Z");
    const second = await listChatSessionsPage(h.layer().db, { limit: 2, cursor: first.nextCursor! });
    expect([...first.sessions, ...second.sessions].map((session) => session.id)).toEqual(["chat-c", "chat-b", "chat-a"]);
    expect((await listChatSessionsPage(h.layer().db, { q: "needle" })).sessions.map((session) => session.id)).toEqual(["chat-c", "chat-b"]);
    expect(() => decodeChatSessionCursor("not-a-cursor")).toThrow("Invalid chat session cursor");

    await h.layer().db.delete(schema.project.chatSessions).where(eq(schema.project.chatSessions.id, "chat-a"));
    const afterDelete = await listChatSessionsPage(h.layer().db, { limit: 2, cursor: first.nextCursor! });
    expect(afterDelete.sessions).toEqual([]);
  });
});

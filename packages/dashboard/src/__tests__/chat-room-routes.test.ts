import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatStore, Database } from "@fusion/core";
import { request } from "../test-request.js";

class MockStore {
  constructor(private readonly rootDir: string, private readonly db: Database) {}

  getRootDir(): string { return this.rootDir; }
  getFusionDir(): string { return join(this.rootDir, ".fusion"); }
  getKbDir(): string { return join(this.rootDir, ".fusion"); }
  getDatabase(): Database { return this.db; }
}

describe("Chat Room API Routes", () => {
  let tempRoot: string;
  let db: Database;
  let store: MockStore;
  let chatStore: ChatStore;
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "fusion-chat-room-routes-"));
    const fusionDir = join(tempRoot, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new MockStore(tempRoot, db);
    chatStore = new ChatStore(fusionDir, db);
    const { createServer } = await import("../server.js");
    app = createServer(store as any, { chatStore });
  });

  afterEach(async () => {
    db.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("create + fetch + update + delete room", async () => {
    const createRes = await request(app, "POST", "/api/chat/rooms", JSON.stringify({ name: "Engineering" }), {
      "content-type": "application/json",
    });
    expect(createRes.status).toBe(201);

    const roomId = (createRes.body as any).room.id as string;

    const getRes = await request(app, "GET", `/api/chat/rooms/${roomId}`);
    expect(getRes.status).toBe(200);

    const patchRes = await request(
      app,
      "PATCH",
      `/api/chat/rooms/${roomId}`,
      JSON.stringify({ description: "Core team" }),
      { "content-type": "application/json" },
    );
    expect(patchRes.status).toBe(200);
    expect((patchRes.body as any).room.description).toBe("Core team");

    const delRes = await request(app, "DELETE", `/api/chat/rooms/${roomId}`);
    expect(delRes.status).toBe(200);
    expect((delRes.body as any).success).toBe(true);
  });

  it("validates create and slug collision", async () => {
    const missingName = await request(app, "POST", "/api/chat/rooms", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expect(missingName.status).toBe(400);

    const first = await request(app, "POST", "/api/chat/rooms", JSON.stringify({ name: "Platform Team", projectId: "p1" }), {
      "content-type": "application/json",
    });
    expect(first.status).toBe(201);

    const duplicate = await request(app, "POST", "/api/chat/rooms", JSON.stringify({ name: "platform-team", projectId: "p1" }), {
      "content-type": "application/json",
    });
    expect(duplicate.status).toBe(409);
  });

  it("returns 404 for unknown room", async () => {
    const res = await request(app, "GET", "/api/chat/rooms/room-missing");
    expect(res.status).toBe(404);
  });

  it("handles room members add/delete", async () => {
    const createRes = await request(app, "POST", "/api/chat/rooms", JSON.stringify({ name: "Ops" }), {
      "content-type": "application/json",
    });
    const roomId = (createRes.body as any).room.id as string;

    const addRes = await request(
      app,
      "POST",
      `/api/chat/rooms/${roomId}/members`,
      JSON.stringify({ agentId: "agent-1", role: "member" }),
      { "content-type": "application/json" },
    );
    expect(addRes.status).toBe(201);

    const addRes2 = await request(
      app,
      "POST",
      `/api/chat/rooms/${roomId}/members`,
      JSON.stringify({ agentId: "agent-1", role: "member" }),
      { "content-type": "application/json" },
    );
    expect(addRes2.status).toBe(201);

    const deleteRes = await request(app, "DELETE", `/api/chat/rooms/${roomId}/members/agent-1`);
    expect(deleteRes.status).toBe(200);

    const deleteMissing = await request(app, "DELETE", `/api/chat/rooms/${roomId}/members/agent-1`);
    expect(deleteMissing.status).toBe(404);
  });

  it("persists room message and validates sender/content", async () => {
    const { createServer } = await import("../server.js");
    const appWithRoomReplies = createServer(store as any, {
      chatStore,
      chatManager: {
        sendRoomMessage: async (roomId: string, content: string, attachments?: any[]) => {
          const userMessage = chatStore.addRoomMessage(roomId, {
            role: "user",
            content,
            senderAgentId: null,
            mentions: [],
            ...(Array.isArray(attachments) ? { attachments } : {}),
          });
          chatStore.addRoomMessage(roomId, {
            role: "assistant",
            content: "room reply",
            senderAgentId: "agent-room",
            mentions: [],
          });
          return { userMessage, responders: ["agent-room"] };
        },
      } as any,
    });

    const createRoomRes = await request(appWithRoomReplies, "POST", "/api/chat/rooms", JSON.stringify({ name: "Product" }), {
      "content-type": "application/json",
    });
    const roomId = (createRoomRes.body as any).room.id as string;

    const beforeCount = chatStore.getRoomMessages(roomId).length;

    const postRes = await request(
      appWithRoomReplies,
      "POST",
      `/api/chat/rooms/${roomId}/messages`,
      JSON.stringify({ content: "  hello world  " }),
      { "content-type": "application/json" },
    );
    expect(postRes.status).toBe(201);

    const messageId = (postRes.body as any).message.id as string;
    const persisted = chatStore.getRoomMessage(messageId);
    expect(persisted?.content).toBe("hello world");

    const afterCount = chatStore.getRoomMessages(roomId).length;
    expect(afterCount).toBe(beforeCount + 2);

    const assistantMessages = chatStore.getRoomMessages(roomId).filter((entry) => entry.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      role: "assistant",
      senderAgentId: "agent-room",
    });

    const invalidSender = await request(
      appWithRoomReplies,
      "POST",
      `/api/chat/rooms/${roomId}/messages`,
      JSON.stringify({ content: "x", senderAgentId: "agent-1" }),
      { "content-type": "application/json" },
    );
    expect(invalidSender.status).toBe(400);

    const emptyContent = await request(
      appWithRoomReplies,
      "POST",
      `/api/chat/rooms/${roomId}/messages`,
      JSON.stringify({ content: "   " }),
      { "content-type": "application/json" },
    );
    expect(emptyContent.status).toBe(400);
  });

  it("deletes messages and supports pagination", async () => {
    const room = chatStore.createRoom({ name: "QA" });
    const m1 = chatStore.addRoomMessage(room.id, { role: "user", content: "one" });
    const m2 = chatStore.addRoomMessage(room.id, { role: "user", content: "two" });
    const m3 = chatStore.addRoomMessage(room.id, { role: "user", content: "three" });

    const page = await request(app, "GET", `/api/chat/rooms/${room.id}/messages?limit=2&offset=1`);
    expect(page.status).toBe(200);
    expect((page.body as any).messages.map((m: any) => m.id)).toEqual([m2.id, m3.id]);

    const del1 = await request(app, "DELETE", `/api/chat/rooms/${room.id}/messages/${m1.id}`);
    expect(del1.status).toBe(200);

    const del2 = await request(app, "DELETE", `/api/chat/rooms/${room.id}/messages/${m1.id}`);
    expect(del2.status).toBe(404);
  });

  it("handles message attachments route", async () => {
    const room = chatStore.createRoom({ name: "Files" });
    const message = chatStore.addRoomMessage(room.id, { role: "user", content: "hello" });

    const badPayload = await request(
      app,
      "POST",
      `/api/chat/rooms/${room.id}/messages/${message.id}/attachments`,
      JSON.stringify(null),
      { "content-type": "application/json" },
    );
    expect(badPayload.status).toBe(500);

    const addAttachment = await request(
      app,
      "POST",
      `/api/chat/rooms/${room.id}/messages/${message.id}/attachments`,
      JSON.stringify({
        id: "att-1",
        filename: "a.txt",
        originalName: "a.txt",
        mimeType: "text/plain",
        size: 1,
        createdAt: new Date().toISOString(),
      }),
      { "content-type": "application/json" },
    );
    expect(addAttachment.status).toBe(200);
    expect((addAttachment.body as any).message.attachments).toHaveLength(1);

    const missingMessage = await request(
      app,
      "POST",
      `/api/chat/rooms/${room.id}/messages/missing/attachments`,
      JSON.stringify({
        id: "att-2",
        filename: "b.txt",
        originalName: "b.txt",
        mimeType: "text/plain",
        size: 1,
        createdAt: new Date().toISOString(),
      }),
      { "content-type": "application/json" },
    );
    expect(missingMessage.status).toBe(404);
  });

  it("rate-limits GET /chat/rooms", async () => {
    let status = 200;
    for (let i = 0; i < 1020; i++) {
      const res = await request(app, "GET", "/api/chat/rooms");
      status = res.status;
      if (status === 429) break;
    }
    expect(status).toBe(429);
  });
});

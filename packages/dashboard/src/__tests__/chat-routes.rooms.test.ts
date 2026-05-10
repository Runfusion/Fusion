import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { ChatStore, Database } from "@fusion/core";
import type { TaskStore } from "@fusion/core";
import { request } from "../test-request.js";
import { createSSE } from "../sse.js";

class MockStore {
  constructor(private readonly rootDir: string, private readonly db: Database) {}

  getRootDir(): string { return this.rootDir; }
  getFusionDir(): string { return join(this.rootDir, ".fusion"); }
  getKbDir(): string { return join(this.rootDir, ".fusion"); }
  getDatabase(): Database { return this.db; }
}

class MockSocket extends EventEmitter {
  destroyed = false;
  setKeepAlive = vi.fn();
  destroy = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  });
}

class MockResponse extends EventEmitter {
  headers = new Map<string, string>();
  writableEnded = false;
  destroyed = false;
  write = vi.fn();
  flushHeaders = vi.fn();
  end = vi.fn(() => {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit("close");
  });

  constructor(readonly socket: MockSocket) {
    super();
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

function createMockTaskStore(): TaskStore {
  const researchStore = {
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    on: vi.fn(),
    off: vi.fn(),
    getResearchStore: vi.fn(() => researchStore),
  } as unknown as TaskStore;
}

function openSseConnection(chatStore: ChatStore) {
  const store = createMockTaskStore();
  const socket = new MockSocket();
  const req = new EventEmitter() as Request & { query: Record<string, string>; socket: MockSocket };
  req.query = { clientId: "chat-room-events" };
  req.socket = socket;
  const res = new MockResponse(socket);

  createSSE(store, undefined, undefined, undefined, undefined, undefined, undefined, chatStore)(
    req,
    res as unknown as Response,
  );

  return { req, res };
}

describe("Chat HTTP + SSE routes — rooms (FN-3805..FN-3811 contract)", () => {
  let tempRoot: string;
  let db: Database;
  let store: MockStore;
  let chatStore: ChatStore;
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "fusion-chat-routes-rooms-"));
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

  it("covers room CRUD/member routes including validation and slug collisions", async () => {
    const missingName = await request(app, "POST", "/api/chat/rooms", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expect(missingName.status).toBe(400);

    const first = await request(app, "POST", "/api/chat/rooms", JSON.stringify({
      name: "Platform Team",
      projectId: "p1",
      createdBy: "agent-owner",
      memberAgentIds: ["agent-owner", "agent-2"],
    }), { "content-type": "application/json" });
    expect(first.status).toBe(201);
    const roomId = (first.body as any).room.id as string;

    const duplicate = await request(app, "POST", "/api/chat/rooms", JSON.stringify({ name: "platform-team", projectId: "p1" }), {
      "content-type": "application/json",
    });
    expect(duplicate.status).toBe(409);

    const sameSlugOtherProject = await request(app, "POST", "/api/chat/rooms", JSON.stringify({ name: "platform-team", projectId: "p2" }), {
      "content-type": "application/json",
    });
    expect(sameSlugOtherProject.status).toBe(201);

    const listByAgent = await request(app, "GET", "/api/chat/rooms?projectId=p1&agentId=agent-2");
    expect(listByAgent.status).toBe(200);
    expect((listByAgent.body as any).rooms).toHaveLength(1);

    const unknownRoom = await request(app, "GET", "/api/chat/rooms/room-missing");
    expect(unknownRoom.status).toBe(404);

    const addMember = await request(
      app,
      "POST",
      `/api/chat/rooms/${roomId}/members`,
      JSON.stringify({ agentId: "agent-3", role: "member" }),
      { "content-type": "application/json" },
    );
    expect(addMember.status).toBe(201);

    const removeMember = await request(app, "DELETE", `/api/chat/rooms/${roomId}/members/agent-3`);
    expect(removeMember.status).toBe(200);

    const removeMemberAgain = await request(app, "DELETE", `/api/chat/rooms/${roomId}/members/agent-3`);
    expect(removeMemberAgain.status).toBe(404);
  });

  it("covers room message route contracts: trim, senderAgentId rejection, before cursor, delete idempotency, attachments", async () => {
    const { createServer } = await import("../server.js");
    const appWithRoomReplies = createServer(store as any, {
      chatStore,
      chatManager: {
        sendRoomMessage: async (roomId: string, content: string, attachments?: any[]) => {
          const userMessage = chatStore.addRoomMessage(roomId, {
            role: "user",
            content,
            senderAgentId: null,
            mentions: ["agent-room"],
            ...(Array.isArray(attachments) ? { attachments } : {}),
          });
          chatStore.addRoomMessage(roomId, {
            role: "assistant",
            content: "room reply",
            senderAgentId: "agent-room",
            mentions: ["agent-room"],
          });
          return { userMessage, responders: ["agent-room"] };
        },
      } as any,
    });

    const createRoomRes = await request(appWithRoomReplies, "POST", "/api/chat/rooms", JSON.stringify({ name: "Product" }), {
      "content-type": "application/json",
    });
    const roomId = (createRoomRes.body as any).room.id as string;

    const postRes = await request(
      appWithRoomReplies,
      "POST",
      `/api/chat/rooms/${roomId}/messages`,
      JSON.stringify({ content: "  hello @agent_room  " }),
      { "content-type": "application/json" },
    );
    expect(postRes.status).toBe(201);
    const messageId = (postRes.body as any).message.id as string;
    const persisted = chatStore.getRoomMessage(messageId);
    expect(persisted?.content).toBe("hello @agent_room");

    const invalidSender = await request(
      appWithRoomReplies,
      "POST",
      `/api/chat/rooms/${roomId}/messages`,
      JSON.stringify({ content: "x", senderAgentId: "agent-1" }),
      { "content-type": "application/json" },
    );
    expect(invalidSender.status).toBe(400);

    const first = chatStore.addRoomMessage(roomId, { role: "user", content: "first" });
    await new Promise((r) => setTimeout(r, 5));
    const second = chatStore.addRoomMessage(roomId, { role: "user", content: "second" });
    await new Promise((r) => setTimeout(r, 5));
    chatStore.addRoomMessage(roomId, { role: "user", content: "third" });

    const page = await request(appWithRoomReplies, "GET", `/api/chat/rooms/${roomId}/messages?before=${second.createdAt}`);
    expect(page.status).toBe(200);
    expect((page.body as any).messages.map((m: any) => m.id)).toContain(first.id);

    const del1 = await request(appWithRoomReplies, "DELETE", `/api/chat/rooms/${roomId}/messages/${messageId}`);
    expect(del1.status).toBe(200);
    const del2 = await request(appWithRoomReplies, "DELETE", `/api/chat/rooms/${roomId}/messages/${messageId}`);
    expect(del2.status).toBe(404);

    const attachmentTarget = chatStore.addRoomMessage(roomId, { role: "user", content: "attach" });
    const addAttachment = await request(
      appWithRoomReplies,
      "POST",
      `/api/chat/rooms/${roomId}/messages/${attachmentTarget.id}/attachments`,
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
  });

  it("emits room SSE payloads for lifecycle/member/message events and cleans up listeners", () => {
    const { req, res } = openSseConnection(chatStore);

    const room = chatStore.createRoom({
      name: "engineering",
      projectId: "proj-1",
      createdBy: "agent-owner",
      memberAgentIds: ["agent-owner"],
    });
    const member = chatStore.addRoomMember(room.id, "agent-2", "member");
    const message = chatStore.addRoomMessage(room.id, {
      role: "user",
      content: "hello room",
      senderAgentId: null,
      mentions: [],
    });
    const updatedRoom = chatStore.updateRoom(room.id, { description: "updated" });
    expect(updatedRoom).toBeDefined();
    chatStore.removeRoomMember(room.id, "agent-2");
    const attachmentUpdatedMessage = chatStore.addRoomMessageAttachment(room.id, message.id, {
      id: "att-1",
      filename: "doc.txt",
      originalName: "doc.txt",
      mimeType: "text/plain",
      size: 3,
      createdAt: new Date().toISOString(),
    });
    chatStore.deleteRoomMessage(message.id);
    chatStore.deleteRoom(room.id);

    expect(res.write).toHaveBeenCalledWith(`event: chat:room:created\ndata: ${JSON.stringify(room)}\n\n`);
    expect(res.write).toHaveBeenCalledWith(`event: chat:room:updated\ndata: ${JSON.stringify(updatedRoom)}\n\n`);
    expect(res.write).toHaveBeenCalledWith(`event: chat:room:deleted\ndata: ${JSON.stringify({ id: room.id })}\n\n`);
    expect(res.write).toHaveBeenCalledWith(`event: chat:room:member:added\ndata: ${JSON.stringify(member)}\n\n`);
    expect(res.write).toHaveBeenCalledWith(
      `event: chat:room:member:removed\ndata: ${JSON.stringify({ roomId: room.id, agentId: "agent-2" })}\n\n`,
    );
    expect(res.write).toHaveBeenCalledWith(`event: chat:room:message:added\ndata: ${JSON.stringify(message)}\n\n`);
    expect(res.write).toHaveBeenCalledWith(`event: chat:room:message:updated\ndata: ${JSON.stringify(attachmentUpdatedMessage)}\n\n`);
    expect(res.write).toHaveBeenCalledWith(`event: chat:room:message:deleted\ndata: ${JSON.stringify({ id: message.id })}\n\n`);

    req.emit("close");

    expect(EventEmitter.listenerCount(chatStore, "chat:room:created")).toBe(0);
    expect(EventEmitter.listenerCount(chatStore, "chat:room:updated")).toBe(0);
    expect(EventEmitter.listenerCount(chatStore, "chat:room:deleted")).toBe(0);
    expect(EventEmitter.listenerCount(chatStore, "chat:room:member:added")).toBe(0);
    expect(EventEmitter.listenerCount(chatStore, "chat:room:member:removed")).toBe(0);
    expect(EventEmitter.listenerCount(chatStore, "chat:room:message:added")).toBe(0);
    expect(EventEmitter.listenerCount(chatStore, "chat:room:message:updated")).toBe(0);
    expect(EventEmitter.listenerCount(chatStore, "chat:room:message:deleted")).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChatStore } from "../chat-store.js";
import { Database } from "../db.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-chat-store-rooms-test-"));
}

describe("ChatStore — rooms (FN-3805..FN-3811 contract)", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;
  let store: ChatStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new ChatStore(fusionDir, db);
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("Room lifecycle and membership", () => {
    it("normalizes slug, assigns owner/member roles, and supports room lifecycle lookups", () => {
      const room = store.createRoom({
        name: "#Engineering Team",
        projectId: "proj-1",
        createdBy: "agent-owner",
        memberAgentIds: ["agent-owner", "agent-2"],
      });

      expect(room.name).toBe("Engineering Team");
      expect(room.slug).toBe("engineering-team");

      const members = store.listRoomMembers(room.id);
      expect(members.find((m) => m.agentId === "agent-owner")?.role).toBe("owner");
      expect(members.find((m) => m.agentId === "agent-2")?.role).toBe("member");

      expect(store.getRoom(room.id)?.id).toBe(room.id);
      expect(store.getRoomBySlug("proj-1", "engineering-team")?.id).toBe(room.id);

      const updated = store.updateRoom(room.id, { name: "#Engineering Core", description: "core", status: "archived" });
      expect(updated?.slug).toBe("engineering-core");
      expect(updated?.status).toBe("archived");
      expect(store.deleteRoom(room.id)).toBe(true);
      expect(store.getRoom(room.id)).toBeUndefined();
    });

    it("rejects same-project slug collision while allowing cross-project duplicates", () => {
      store.createRoom({ name: "engineering", projectId: "proj-1" });
      expect(() => store.createRoom({ name: "#Engineering", projectId: "proj-1" })).toThrow("already exists");
      expect(() => store.createRoom({ name: "#Engineering", projectId: "proj-2" })).not.toThrow();
    });

    it("keeps member add idempotent, supports removal, listRoomsForAgent filters, and cascades delete", () => {
      const room = store.createRoom({ name: "ops", projectId: "proj-1", createdBy: "agent-1" });

      store.addRoomMember(room.id, "agent-2");
      store.addRoomMember(room.id, "agent-2");
      expect(store.listRoomMembers(room.id).filter((m) => m.agentId === "agent-2")).toHaveLength(1);

      const archived = store.updateRoom(room.id, { status: "archived" });
      expect(archived?.status).toBe("archived");
      expect(store.listRoomsForAgent("agent-2", { projectId: "proj-1", status: "archived" })).toHaveLength(1);

      expect(store.removeRoomMember(room.id, "agent-2")).toBe(true);
      expect(store.removeRoomMember(room.id, "agent-2")).toBe(false);

      store.addRoomMember(room.id, "agent-3");
      store.addRoomMessage(room.id, { role: "user", content: "hello", mentions: ["agent-3"] });
      store.deleteRoom(room.id);
      expect(store.listRoomMembers(room.id)).toHaveLength(0);
      expect(store.getRoomMessages(room.id)).toHaveLength(0);
    });
  });

  describe("Room message persistence and retrieval", () => {
    it("supports timeline, before cursor, mention round-trip, and attachment append", async () => {
      const room = store.createRoom({ name: "support", projectId: "proj-1" });
      const first = store.addRoomMessage(room.id, { role: "user", content: "first", mentions: ["agent-1"] });
      await new Promise((r) => setTimeout(r, 5));
      const second = store.addRoomMessage(room.id, { role: "assistant", content: "second", senderAgentId: "agent-1" });

      expect(store.getRoomMessage(first.id)?.mentions).toEqual(["agent-1"]);
      expect(store.getRoomMessages(room.id, { before: second.createdAt }).map((m) => m.id)).toEqual([first.id]);

      const updated = store.addRoomMessageAttachment(room.id, second.id, {
        id: "att-room",
        filename: "room.txt",
        originalName: "room.txt",
        mimeType: "text/plain",
        size: 10,
        createdAt: new Date().toISOString(),
      });
      expect(updated.attachments?.[0]?.id).toBe("att-room");
    });

    it("keeps cross-room and direct-vs-room histories isolated", () => {
      const session = store.createSession({ agentId: "agent-1" });
      store.addMessage(session.id, { role: "user", content: "direct" });

      const roomA = store.createRoom({ name: "room-a" });
      const roomB = store.createRoom({ name: "room-b" });
      store.addRoomMessage(roomA.id, { role: "user", content: "a1" });
      store.addRoomMessage(roomB.id, { role: "user", content: "b1" });

      expect(store.getRoomMessages(roomA.id).map((m) => m.content)).toEqual(["a1"]);
      expect(store.getRoomMessages(roomB.id).map((m) => m.content)).toEqual(["b1"]);
      expect(store.getMessages(session.id).map((m) => m.content)).toEqual(["direct"]);
    });
  });

  describe("Room events", () => {
    it("emits room lifecycle/member/message events", () => {
      const created = vi.fn();
      const updated = vi.fn();
      const deleted = vi.fn();
      const memberAdded = vi.fn();
      const memberRemoved = vi.fn();
      const messageAdded = vi.fn();
      const messageUpdated = vi.fn();
      const messageDeleted = vi.fn();

      store.on("chat:room:created", created);
      store.on("chat:room:updated", updated);
      store.on("chat:room:deleted", deleted);
      store.on("chat:room:member:added", memberAdded);
      store.on("chat:room:member:removed", memberRemoved);
      store.on("chat:room:message:added", messageAdded);
      store.on("chat:room:message:updated", messageUpdated);
      store.on("chat:room:message:deleted", messageDeleted);

      const room = store.createRoom({ name: "events", createdBy: "agent-1", memberAgentIds: ["agent-1"] });
      const roomUpdate = store.updateRoom(room.id, { description: "updated" });
      const member = store.addRoomMember(room.id, "agent-2");
      const message = store.addRoomMessage(room.id, { role: "user", content: "hi" });
      const msgUpdate = store.addRoomMessageAttachment(room.id, message.id, {
        id: "att-1",
        filename: "a.txt",
        originalName: "a.txt",
        mimeType: "text/plain",
        size: 1,
        createdAt: new Date().toISOString(),
      });
      store.removeRoomMember(room.id, "agent-2");
      store.deleteRoomMessage(message.id);
      store.deleteRoom(room.id);

      expect(created).toHaveBeenCalledWith(room);
      expect(updated).toHaveBeenCalledWith(roomUpdate);
      expect(memberAdded).toHaveBeenCalledWith(member);
      expect(messageAdded).toHaveBeenCalledWith(message);
      expect(messageUpdated).toHaveBeenCalledWith(msgUpdate);
      expect(memberRemoved).toHaveBeenCalledWith({ roomId: room.id, agentId: "agent-2" });
      expect(messageDeleted).toHaveBeenCalledWith(message.id);
      expect(deleted).toHaveBeenCalledWith(room.id);
    });
  });
});

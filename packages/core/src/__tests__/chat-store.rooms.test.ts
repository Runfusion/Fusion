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

    it("returns only messages after sinceIso", async () => {
      const room = store.createRoom({ name: "since-test" });
      store.addRoomMessage(room.id, { role: "user", content: "before" });
      await new Promise((r) => setTimeout(r, 5));
      const sinceIso = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 5));
      const after = store.addRoomMessage(room.id, { role: "user", content: "after" });

      expect(store.listRoomMessagesSince(room.id, sinceIso).map((message) => message.id)).toEqual([after.id]);
    });

    it("excludes authored agent messages when excludeSenderAgentId is set", async () => {
      const room = store.createRoom({ name: "exclude-self" });
      store.addRoomMessage(room.id, { role: "assistant", content: "own", senderAgentId: "agent-1" });
      await new Promise((r) => setTimeout(r, 5));
      const other = store.addRoomMessage(room.id, { role: "assistant", content: "other", senderAgentId: "agent-2" });
      const user = store.addRoomMessage(room.id, { role: "user", content: "user" });

      expect(
        store.listRoomMessagesSince(room.id, "1970-01-01T00:00:00.000Z", { excludeSenderAgentId: "agent-1" }).map((message) => message.id),
      ).toEqual([other.id, user.id]);
    });

    it("respects the limit cap", async () => {
      const room = store.createRoom({ name: "limit-test" });
      store.addRoomMessage(room.id, { role: "user", content: "one" });
      store.addRoomMessage(room.id, { role: "user", content: "two" });
      store.addRoomMessage(room.id, { role: "user", content: "three" });

      expect(store.listRoomMessagesSince(room.id, "1970-01-01T00:00:00.000Z", { limit: 2 }).map((message) => message.content)).toEqual([
        "one",
        "two",
      ]);
    });

    it("returns empty when there are no new room messages", () => {
      const room = store.createRoom({ name: "empty-test" });
      store.addRoomMessage(room.id, { role: "user", content: "old" });

      expect(store.listRoomMessagesSince(room.id, new Date().toISOString())).toEqual([]);
    });

    it("returns newest limited room window when order is desc while preserving ascending output", () => {
      const room = store.createRoom({ name: "window-test" });

      for (let i = 1; i <= 107; i += 1) {
        store.addRoomMessage(room.id, { role: "user", content: `message-${i}` });
      }

      const newestWindow = store.getRoomMessages(room.id, { limit: 100, order: "desc" });
      expect(newestWindow).toHaveLength(100);
      expect(newestWindow[0]?.content).toBe("message-8");
      expect(newestWindow.at(-1)?.content).toBe("message-107");
      expect(newestWindow.some((message) => message.content === "message-1")).toBe(false);

      const legacyWindow = store.getRoomMessages(room.id, { limit: 100 });
      expect(legacyWindow).toHaveLength(100);
      expect(legacyWindow[0]?.content).toBe("message-1");
      expect(legacyWindow.at(-1)?.content).toBe("message-100");
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

    it("clears all room messages while preserving room and advancing updatedAt", async () => {
      const room = store.createRoom({ name: "clear-room" });
      store.addRoomMessage(room.id, { role: "user", content: "one" });
      store.addRoomMessage(room.id, { role: "assistant", content: "two" });
      const before = store.getRoom(room.id)?.updatedAt;

      await new Promise((r) => setTimeout(r, 5));
      const deletedCount = store.clearRoomMessages(room.id);

      expect(deletedCount).toBe(2);
      expect(store.getRoomMessages(room.id)).toEqual([]);
      expect(store.getRoom(room.id)).toBeDefined();
      expect(store.getRoom(room.id)?.updatedAt > (before ?? "")).toBe(true);
    });

    it("returns 0 when clearing a non-existent room", () => {
      expect(store.clearRoomMessages("room-missing")).toBe(0);
    });

    it("returns 0 and does not emit clear event when clearing an empty room", () => {
      const room = store.createRoom({ name: "empty-clear" });
      const cleared = vi.fn();
      store.on("chat:room:messages:cleared", cleared);

      expect(store.clearRoomMessages(room.id)).toBe(0);
      expect(cleared).not.toHaveBeenCalled();
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
      const messagesCleared = vi.fn();

      store.on("chat:room:created", created);
      store.on("chat:room:updated", updated);
      store.on("chat:room:deleted", deleted);
      store.on("chat:room:member:added", memberAdded);
      store.on("chat:room:member:removed", memberRemoved);
      store.on("chat:room:message:added", messageAdded);
      store.on("chat:room:message:updated", messageUpdated);
      store.on("chat:room:message:deleted", messageDeleted);
      store.on("chat:room:messages:cleared", messagesCleared);

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
      store.addRoomMessage(room.id, { role: "user", content: "clear-me" });
      store.removeRoomMember(room.id, "agent-2");
      store.deleteRoomMessage(message.id);
      const clearedCount = store.clearRoomMessages(room.id);
      const refreshedRoom = store.getRoom(room.id);
      store.deleteRoom(room.id);

      expect(created).toHaveBeenCalledWith(room);
      expect(updated).toHaveBeenCalledWith(roomUpdate);
      expect(memberAdded).toHaveBeenCalledWith(member);
      expect(messageAdded).toHaveBeenCalledWith(message);
      expect(messageUpdated).toHaveBeenCalledWith(msgUpdate);
      expect(memberRemoved).toHaveBeenCalledWith({ roomId: room.id, agentId: "agent-2" });
      expect(messageDeleted).toHaveBeenCalledWith(message.id);
      expect(clearedCount).toBe(1);
      expect(messagesCleared).toHaveBeenCalledTimes(1);
      expect(messagesCleared).toHaveBeenCalledWith({ roomId: room.id, deletedCount: 1 });
      expect(updated).toHaveBeenCalledWith(refreshedRoom);
      expect(deleted).toHaveBeenCalledWith(room.id);
    });
  });
});

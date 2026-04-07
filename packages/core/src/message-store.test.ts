import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessageStore } from "./message-store.js";
import type { Message, Mailbox } from "./types.js";

describe("MessageStore", () => {
  let store: MessageStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-msg-test-"));
    store = new MessageStore({ rootDir: tempDir });
    await store.init();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("init()", () => {
    it("creates messages directory and index file", async () => {
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(tempDir, "messages"))).toBe(true);
      expect(existsSync(join(tempDir, "messages", "index.json"))).toBe(true);
    });

    it("is idempotent — calling init twice does not throw", async () => {
      await store.init();
      await store.init();
    });
  });

  describe("sendMessage() and getMessage()", () => {
    it("creates and retrieves a message", async () => {
      const message = await store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Hello agent!",
        type: "user-to-agent",
      });

      expect(message.id).toBeTruthy();
      expect(message.id).toMatch(/^msg-/);
      expect(message.fromId).toBe("user-1");
      expect(message.fromType).toBe("user");
      expect(message.toId).toBe("agent-1");
      expect(message.toType).toBe("agent");
      expect(message.content).toBe("Hello agent!");
      expect(message.type).toBe("user-to-agent");
      expect(message.read).toBe(false);
      expect(message.createdAt).toBeTruthy();
      expect(message.updatedAt).toBeTruthy();

      const retrieved = await store.getMessage(message.id);
      expect(retrieved).toEqual(message);
    });

    it("auto-fills sender as system when not provided", async () => {
      const message = await store.sendMessage({
        toId: "user-1",
        toType: "user",
        content: "System notification",
        type: "system",
      });

      expect(message.fromId).toBe("system");
      expect(message.fromType).toBe("system");
    });

    it("stores metadata when provided", async () => {
      const message = await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Task completed",
        type: "agent-to-user",
        metadata: { taskId: "FN-001", priority: "high" },
      });

      expect(message.metadata).toEqual({ taskId: "FN-001", priority: "high" });
    });

    it("returns null for non-existent message", async () => {
      const result = await store.getMessage("msg-nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getInbox()", () => {
    it("returns inbox messages for a participant", async () => {
      await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Message 1",
        type: "agent-to-user",
      });

      await store.sendMessage({
        fromId: "agent-2",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Message 2",
        type: "agent-to-user",
      });

      const inbox = await store.getInbox("user-1", "user");
      expect(inbox).toHaveLength(2);
      // Newest first
      expect(inbox[0].content).toBe("Message 2");
      expect(inbox[1].content).toBe("Message 1");
    });

    it("returns empty array for participant with no messages", async () => {
      const inbox = await store.getInbox("user-99", "user");
      expect(inbox).toEqual([]);
    });

    it("filters by read status", async () => {
      const msg1 = await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Unread",
        type: "agent-to-user",
      });

      const msg2 = await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Will be read",
        type: "agent-to-user",
      });

      await store.markAsRead(msg2.id);

      const unreadOnly = await store.getInbox("user-1", "user", { read: false });
      expect(unreadOnly).toHaveLength(1);
      expect(unreadOnly[0].id).toBe(msg1.id);

      const readOnly = await store.getInbox("user-1", "user", { read: true });
      expect(readOnly).toHaveLength(1);
      expect(readOnly[0].id).toBe(msg2.id);
    });

    it("applies pagination (limit/offset)", async () => {
      for (let i = 0; i < 5; i++) {
        await store.sendMessage({
          fromId: "agent-1",
          fromType: "agent",
          toId: "user-1",
          toType: "user",
          content: `Message ${i}`,
          type: "agent-to-user",
        });
      }

      const page1 = await store.getInbox("user-1", "user", { limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = await store.getInbox("user-1", "user", { limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      // No overlap
      expect(page1[0].id).not.toBe(page2[0].id);
    });

    it("filters by message type", async () => {
      await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Agent message",
        type: "agent-to-user",
      });

      await store.sendMessage({
        fromId: "system",
        fromType: "system",
        toId: "user-1",
        toType: "user",
        content: "System message",
        type: "system",
      });

      const agentOnly = await store.getInbox("user-1", "user", { type: "agent-to-user" });
      expect(agentOnly).toHaveLength(1);
      expect(agentOnly[0].type).toBe("agent-to-user");

      const systemOnly = await store.getInbox("user-1", "user", { type: "system" });
      expect(systemOnly).toHaveLength(1);
      expect(systemOnly[0].type).toBe("system");
    });
  });

  describe("getOutbox()", () => {
    it("returns sent messages for a participant", async () => {
      await store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Outgoing 1",
        type: "user-to-agent",
      });

      await store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-2",
        toType: "agent",
        content: "Outgoing 2",
        type: "user-to-agent",
      });

      const outbox = await store.getOutbox("user-1", "user");
      expect(outbox).toHaveLength(2);
      expect(outbox[0].content).toBe("Outgoing 2");
      expect(outbox[1].content).toBe("Outgoing 1");
    });

    it("returns empty array when no messages sent", async () => {
      const outbox = await store.getOutbox("user-99", "user");
      expect(outbox).toEqual([]);
    });
  });

  describe("markAsRead()", () => {
    it("marks a message as read", async () => {
      const message = await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Read me",
        type: "agent-to-user",
      });

      expect(message.read).toBe(false);

      const updated = await store.markAsRead(message.id);
      expect(updated.read).toBe(true);

      const retrieved = await store.getMessage(message.id);
      expect(retrieved!.read).toBe(true);
    });

    it("is idempotent for already-read messages", async () => {
      const message = await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Already read",
        type: "agent-to-user",
      });

      await store.markAsRead(message.id);
      const updated = await store.markAsRead(message.id);
      expect(updated.read).toBe(true);
    });

    it("throws for non-existent message", async () => {
      await expect(store.markAsRead("msg-nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("markAllAsRead()", () => {
    it("marks all unread messages as read", async () => {
      await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Msg 1",
        type: "agent-to-user",
      });

      await store.sendMessage({
        fromId: "agent-2",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Msg 2",
        type: "agent-to-user",
      });

      const count = await store.markAllAsRead("user-1", "user");
      expect(count).toBe(2);

      const inbox = await store.getInbox("user-1", "user");
      expect(inbox.every((m) => m.read)).toBe(true);
    });

    it("returns 0 when no unread messages", async () => {
      const count = await store.markAllAsRead("user-99", "user");
      expect(count).toBe(0);
    });
  });

  describe("deleteMessage()", () => {
    it("deletes a message", async () => {
      const message = await store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Delete me",
        type: "user-to-agent",
      });

      await store.deleteMessage(message.id);

      const retrieved = await store.getMessage(message.id);
      expect(retrieved).toBeNull();
    });

    it("removes message from inbox index", async () => {
      const message = await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Delete me",
        type: "agent-to-user",
      });

      await store.deleteMessage(message.id);

      const inbox = await store.getInbox("user-1", "user");
      expect(inbox).toHaveLength(0);
    });

    it("removes message from outbox index", async () => {
      const message = await store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Delete me",
        type: "user-to-agent",
      });

      await store.deleteMessage(message.id);

      const outbox = await store.getOutbox("user-1", "user");
      expect(outbox).toHaveLength(0);
    });

    it("throws for non-existent message", async () => {
      await expect(store.deleteMessage("msg-nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("getConversation()", () => {
    it("returns all messages between two participants", async () => {
      // user-1 sends to agent-1
      await store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Hello",
        type: "user-to-agent",
      });

      // agent-1 replies to user-1
      await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Hi there",
        type: "agent-to-user",
      });

      // Unrelated message
      await store.sendMessage({
        fromId: "agent-2",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Unrelated",
        type: "agent-to-user",
      });

      const conversation = await store.getConversation(
        { id: "user-1", type: "user" },
        { id: "agent-1", type: "agent" },
      );

      expect(conversation).toHaveLength(2);
      // Oldest first
      expect(conversation[0].content).toBe("Hello");
      expect(conversation[1].content).toBe("Hi there");
    });

    it("returns empty array when no conversation exists", async () => {
      const conversation = await store.getConversation(
        { id: "user-1", type: "user" },
        { id: "agent-99", type: "agent" },
      );
      expect(conversation).toEqual([]);
    });
  });

  describe("getMailbox()", () => {
    it("returns mailbox summary with unread count", async () => {
      await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Unread 1",
        type: "agent-to-user",
      });

      await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Unread 2",
        type: "agent-to-user",
      });

      const mailbox = await store.getMailbox("user-1", "user");

      expect(mailbox.ownerId).toBe("user-1");
      expect(mailbox.ownerType).toBe("user");
      expect(mailbox.unreadCount).toBe(2);
      expect(mailbox.lastMessage).toBeTruthy();
      expect(mailbox.lastMessage!.content).toBe("Unread 2");
    });

    it("returns 0 unread when no messages", async () => {
      const mailbox = await store.getMailbox("user-99", "user");
      expect(mailbox.unreadCount).toBe(0);
      expect(mailbox.lastMessage).toBeUndefined();
    });

    it("counts only unread messages", async () => {
      const msg1 = await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Will be read",
        type: "agent-to-user",
      });

      await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Stays unread",
        type: "agent-to-user",
      });

      await store.markAsRead(msg1.id);

      const mailbox = await store.getMailbox("user-1", "user");
      expect(mailbox.unreadCount).toBe(1);
    });
  });

  describe("events", () => {
    it("emits message:sent event on send", async () => {
      const events: Message[] = [];
      store.on("message:sent", (msg) => events.push(msg));

      await store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Hello",
        type: "user-to-agent",
      });

      expect(events).toHaveLength(1);
      expect(events[0].content).toBe("Hello");
    });

    it("emits message:received event on send", async () => {
      const events: Message[] = [];
      store.on("message:received", (msg) => events.push(msg));

      await store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Hello",
        type: "user-to-agent",
      });

      expect(events).toHaveLength(1);
    });

    it("emits message:read event on mark as read", async () => {
      const events: Message[] = [];
      store.on("message:read", (msg) => events.push(msg));

      const message = await store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Read me",
        type: "agent-to-user",
      });

      await store.markAsRead(message.id);

      expect(events).toHaveLength(1);
      expect(events[0].read).toBe(true);
    });

    it("emits message:deleted event on delete", async () => {
      const events: string[] = [];
      store.on("message:deleted", (id) => events.push(id));

      const message = await store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Delete me",
        type: "user-to-agent",
      });

      await store.deleteMessage(message.id);

      expect(events).toHaveLength(1);
      expect(events[0]).toBe(message.id);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../db.js";
import { MessageStore } from "../message-store.js";
import { DASHBOARD_USER_ID } from "../types.js";
import type { Message, Mailbox } from "../types.js";

describe("MessageStore", () => {
  let store: MessageStore;
  let db: Database;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-msg-test-"));
    // In-memory SQLite for test speed; see store.test.ts beforeEach.
    db = new Database(tempDir, { inMemory: true });
    db.init();
    store = new MessageStore(db);
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("sendMessage() and getMessage()", () => {
    it("creates and retrieves a message", () => {
      const message = store.sendMessage({
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

      const retrieved = store.getMessage(message.id);
      expect(retrieved).toEqual(message);
    });

    it("auto-fills sender as system when not provided", () => {
      const message = store.sendMessage({
        toId: "user-1",
        toType: "user",
        content: "System notification",
        type: "system",
      });

      expect(message.fromId).toBe("system");
      expect(message.fromType).toBe("system");
    });

    it("stores metadata when provided", () => {
      const message = store.sendMessage({
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

    it("persists reply link metadata through storage roundtrip", () => {
      const original = store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Can you help?",
        type: "user-to-agent",
      });

      const reply = store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Sure",
        type: "agent-to-user",
        metadata: { replyTo: { messageId: original.id } },
      });

      expect(reply.metadata).toEqual({ replyTo: { messageId: original.id } });
      expect(store.getMessage(reply.id)?.metadata).toEqual({ replyTo: { messageId: original.id } });
    });

    it("persists wakeRecipient metadata through storage roundtrip", () => {
      const message = store.sendMessage({
        fromId: "user:dashboard",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "urgent",
        type: "user-to-agent",
        metadata: { wakeRecipient: true },
      });

      expect(message.metadata).toEqual({ wakeRecipient: true });
      expect(store.getMessage(message.id)?.metadata).toEqual({ wakeRecipient: true });
    });

    it("rejects non-boolean wakeRecipient metadata", () => {
      expect(() => {
        store.sendMessage({
          fromId: "user:dashboard",
          fromType: "user",
          toId: "agent-1",
          toType: "agent",
          content: "Bad metadata",
          type: "user-to-agent",
          // @ts-expect-error intentional bad type for runtime validation
          metadata: { wakeRecipient: "yes" },
        });
      }).toThrow("metadata.wakeRecipient must be a boolean");
    });

    it("rejects malformed reply metadata", () => {
      expect(() => {
        store.sendMessage({
          fromId: "agent-1",
          fromType: "agent",
          toId: "user-1",
          toType: "user",
          content: "Bad metadata",
          type: "agent-to-user",
          metadata: { replyTo: { messageId: "" } },
        });
      }).toThrow("metadata.replyTo.messageId must be a non-empty string");
    });

    it("returns null for non-existent message", () => {
      const result = store.getMessage("msg-nonexistent");
      expect(result).toBeNull();
    });

    it.each(["dashboard", "user:dashboard", "User: user:dashboard"])(
      "canonicalizes dashboard user alias '%s' when writing recipient",
      (dashboardAlias) => {
        const message = store.sendMessage({
          fromId: "agent-1",
          fromType: "agent",
          toId: dashboardAlias,
          toType: "user",
          content: "Hello dashboard",
          type: "agent-to-user",
        });

        expect(message.toId).toBe(DASHBOARD_USER_ID);
        expect(store.getMessage(message.id)?.toId).toBe(DASHBOARD_USER_ID);
      },
    );

    it.each(["dashboard", "user:dashboard", "User: user:dashboard"])(
      "canonicalizes dashboard user alias '%s' when writing sender",
      (dashboardAlias) => {
        const message = store.sendMessage({
          fromId: dashboardAlias,
          fromType: "user",
          toId: "agent-1",
          toType: "agent",
          content: "Reply",
          type: "user-to-agent",
        });

        expect(message.fromId).toBe(DASHBOARD_USER_ID);
        expect(store.getMessage(message.id)?.fromId).toBe(DASHBOARD_USER_ID);
      },
    );
  });

  describe("message-to-agent hook", () => {
    it("does not call the hook for non-agent recipients", () => {
      const hook = vi.fn();
      const hookedStore = new MessageStore(db, { onMessageToAgent: hook });

      hookedStore.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Hello user",
        type: "agent-to-user",
      });

      expect(hook).not.toHaveBeenCalled();
    });

    it("calls the hook when a message is sent to an agent", () => {
      const hook = vi.fn();
      const hookedStore = new MessageStore(db, { onMessageToAgent: hook });

      const message = hookedStore.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Hello agent",
        type: "user-to-agent",
      });

      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook).toHaveBeenCalledWith(message);
    });

    it("does nothing when no hook is configured", () => {
      expect(() => {
        store.sendMessage({
          fromId: "user-1",
          fromType: "user",
          toId: "agent-1",
          toType: "agent",
          content: "No hook configured",
          type: "user-to-agent",
        });
      }).not.toThrow();
    });

    it("setMessageToAgentHook updates the hook used for subsequent messages", () => {
      const firstHook = vi.fn();
      const secondHook = vi.fn();
      const hookedStore = new MessageStore(db, { onMessageToAgent: firstHook });

      hookedStore.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "First",
        type: "user-to-agent",
      });

      hookedStore.setMessageToAgentHook(secondHook);

      hookedStore.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Second",
        type: "user-to-agent",
      });

      expect(firstHook).toHaveBeenCalledTimes(1);
      expect(secondHook).toHaveBeenCalledTimes(1);
    });
  });

  describe("getInbox()", () => {
    it("returns inbox messages for a participant", () => {
      store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Message 1",
        type: "agent-to-user",
      });

      store.sendMessage({
        fromId: "agent-2",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Message 2",
        type: "agent-to-user",
      });

      const inbox = store.getInbox("user-1", "user");
      expect(inbox).toHaveLength(2);
      // Newest first
      expect(inbox[0].content).toBe("Message 2");
      expect(inbox[1].content).toBe("Message 1");
    });

    it("returns empty array for participant with no messages", () => {
      const inbox = store.getInbox("user-99", "user");
      expect(inbox).toEqual([]);
    });

    it("includes legacy dashboard aliases in canonical dashboard inbox reads", () => {
      store.sendMessage({ fromId: "agent-1", fromType: "agent", toId: DASHBOARD_USER_ID, toType: "user", content: "A", type: "agent-to-user" });
      store.sendMessage({ fromId: "agent-1", fromType: "agent", toId: "user:dashboard", toType: "user", content: "B", type: "agent-to-user" });
      store.sendMessage({ fromId: "agent-1", fromType: "agent", toId: "User: user:dashboard", toType: "user", content: "C", type: "agent-to-user" });

      const inbox = store.getInbox(DASHBOARD_USER_ID, "user");
      expect(inbox).toHaveLength(3);
    });

    it("filters by read status", () => {
      const msg1 = store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Unread",
        type: "agent-to-user",
      });

      const msg2 = store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Will be read",
        type: "agent-to-user",
      });

      store.markAsRead(msg2.id);

      const unreadOnly = store.getInbox("user-1", "user", { read: false });
      expect(unreadOnly).toHaveLength(1);
      expect(unreadOnly[0].id).toBe(msg1.id);

      const readOnly = store.getInbox("user-1", "user", { read: true });
      expect(readOnly).toHaveLength(1);
      expect(readOnly[0].id).toBe(msg2.id);
    });

    it("applies pagination (limit/offset)", () => {
      for (let i = 0; i < 5; i++) {
        store.sendMessage({
          fromId: "agent-1",
          fromType: "agent",
          toId: "user-1",
          toType: "user",
          content: `Message ${i}`,
          type: "agent-to-user",
        });
      }

      const page1 = store.getInbox("user-1", "user", { limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = store.getInbox("user-1", "user", { limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      // No overlap
      expect(page1[0].id).not.toBe(page2[0].id);
    });

    it("filters by message type", () => {
      store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Agent message",
        type: "agent-to-user",
      });

      store.sendMessage({
        fromId: "system",
        fromType: "system",
        toId: "user-1",
        toType: "user",
        content: "System message",
        type: "system",
      });

      const agentOnly = store.getInbox("user-1", "user", { type: "agent-to-user" });
      expect(agentOnly).toHaveLength(1);
      expect(agentOnly[0].type).toBe("agent-to-user");

      const systemOnly = store.getInbox("user-1", "user", { type: "system" });
      expect(systemOnly).toHaveLength(1);
      expect(systemOnly[0].type).toBe("system");
    });
  });

  describe("getOutbox()", () => {
    it("returns sent messages for a participant", () => {
      store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Outgoing 1",
        type: "user-to-agent",
      });

      store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-2",
        toType: "agent",
        content: "Outgoing 2",
        type: "user-to-agent",
      });

      const outbox = store.getOutbox("user-1", "user");
      expect(outbox).toHaveLength(2);
      expect(outbox[0].content).toBe("Outgoing 2");
      expect(outbox[1].content).toBe("Outgoing 1");
    });

    it("returns empty array when no messages sent", () => {
      const outbox = store.getOutbox("user-99", "user");
      expect(outbox).toEqual([]);
    });
  });

  describe("markAsRead()", () => {
    it("marks a message as read", () => {
      const message = store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Read me",
        type: "agent-to-user",
      });

      expect(message.read).toBe(false);

      const updated = store.markAsRead(message.id);
      expect(updated.read).toBe(true);

      const retrieved = store.getMessage(message.id);
      expect(retrieved!.read).toBe(true);
    });

    it("is idempotent for already-read messages", () => {
      const message = store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Already read",
        type: "agent-to-user",
      });

      store.markAsRead(message.id);
      const updated = store.markAsRead(message.id);
      expect(updated.read).toBe(true);
    });

    it("throws for non-existent message", () => {
      expect(() => store.markAsRead("msg-nonexistent")).toThrow("not found");
    });
  });

  describe("markAllAsRead()", () => {
    it("marks all unread messages as read", () => {
      store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Msg 1",
        type: "agent-to-user",
      });

      store.sendMessage({
        fromId: "agent-2",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Msg 2",
        type: "agent-to-user",
      });

      const count = store.markAllAsRead("user-1", "user");
      expect(count).toBe(2);

      const inbox = store.getInbox("user-1", "user");
      expect(inbox.every((m) => m.read)).toBe(true);
    });

    it("returns 0 when no unread messages", () => {
      const count = store.markAllAsRead("user-99", "user");
      expect(count).toBe(0);
    });

    it("marks canonical dashboard aliases as read together", () => {
      store.sendMessage({ fromId: "agent-1", fromType: "agent", toId: DASHBOARD_USER_ID, toType: "user", content: "A", type: "agent-to-user" });
      store.sendMessage({ fromId: "agent-2", fromType: "agent", toId: "user:dashboard", toType: "user", content: "B", type: "agent-to-user" });
      const marked = store.markAllAsRead(DASHBOARD_USER_ID, "user");
      expect(marked).toBe(2);
      expect(store.getMailbox(DASHBOARD_USER_ID, "user").unreadCount).toBe(0);
    });
  });

  describe("deleteMessage()", () => {
    it("deletes a message", () => {
      const message = store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Delete me",
        type: "user-to-agent",
      });

      store.deleteMessage(message.id);

      const retrieved = store.getMessage(message.id);
      expect(retrieved).toBeNull();
    });

    it("removes message from inbox", () => {
      const message = store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Delete me",
        type: "agent-to-user",
      });

      store.deleteMessage(message.id);

      const inbox = store.getInbox("user-1", "user");
      expect(inbox).toHaveLength(0);
    });

    it("removes message from outbox", () => {
      const message = store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Delete me",
        type: "user-to-agent",
      });

      store.deleteMessage(message.id);

      const outbox = store.getOutbox("user-1", "user");
      expect(outbox).toHaveLength(0);
    });

    it("throws for non-existent message", () => {
      expect(() => store.deleteMessage("msg-nonexistent")).toThrow("not found");
    });
  });

  describe("cleanupOldMessages()", () => {
    it("deletes only messages with updatedAt older than cutoff", () => {
      const oldA = store.sendMessage({ fromId: "user-1", fromType: "user", toId: "agent-1", toType: "agent", content: "old-a", type: "user-to-agent" });
      const oldB = store.sendMessage({ fromId: "agent-2", fromType: "agent", toId: "user-1", toType: "user", content: "old-b", type: "agent-to-user" });
      const recent = store.sendMessage({ fromId: "agent-3", fromType: "agent", toId: "user-2", toType: "user", content: "recent", type: "system" });

      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
      const oneDayAgo = new Date(Date.now() - 1 * 86_400_000).toISOString();
      db.prepare("UPDATE messages SET updatedAt = ? WHERE id = ?").run(tenDaysAgo, oldA.id);
      db.prepare("UPDATE messages SET updatedAt = ? WHERE id = ?").run(tenDaysAgo, oldB.id);
      db.prepare("UPDATE messages SET updatedAt = ? WHERE id = ?").run(oneDayAgo, recent.id);

      const result = store.cleanupOldMessages(7 * 86_400_000);
      expect(result).toEqual({ messagesDeleted: 2 });
      expect(store.getMessage(oldA.id)).toBeNull();
      expect(store.getMessage(oldB.id)).toBeNull();
      expect(store.getMessage(recent.id)).not.toBeNull();
    });

    it("no-ops for non-positive and non-finite maxAgeMs", () => {
      const message = store.sendMessage({ fromId: "user-1", fromType: "user", toId: "agent-1", toType: "agent", content: "keep", type: "user-to-agent" });
      const events: string[] = [];
      store.on("message:deleted", (id) => events.push(id));
      const bumpSpy = vi.spyOn(db, "bumpLastModified");

      expect(store.cleanupOldMessages(0)).toEqual({ messagesDeleted: 0 });
      expect(store.cleanupOldMessages(-1)).toEqual({ messagesDeleted: 0 });
      expect(store.cleanupOldMessages(Number.NaN)).toEqual({ messagesDeleted: 0 });
      expect(store.cleanupOldMessages(Number.POSITIVE_INFINITY)).toEqual({ messagesDeleted: 0 });

      expect(store.getMessage(message.id)).not.toBeNull();
      expect(events).toEqual([]);
      expect(bumpSpy).not.toHaveBeenCalled();
    });

    it("emits message:deleted for each deleted message id", () => {
      const oldA = store.sendMessage({ fromId: "user-1", fromType: "user", toId: "agent-1", toType: "agent", content: "old-a", type: "user-to-agent" });
      const oldB = store.sendMessage({ fromId: "agent-1", fromType: "agent", toId: "user-1", toType: "user", content: "old-b", type: "agent-to-user" });
      const cutoffAge = new Date(Date.now() - 20 * 86_400_000).toISOString();
      db.prepare("UPDATE messages SET updatedAt = ? WHERE id IN (?, ?)").run(cutoffAge, oldA.id, oldB.id);

      const events: string[] = [];
      store.on("message:deleted", (id) => events.push(id));

      const result = store.cleanupOldMessages(7 * 86_400_000);
      expect(result.messagesDeleted).toBe(2);
      expect(new Set(events)).toEqual(new Set([oldA.id, oldB.id]));
    });

    it("handles bulk deletion and bumps lastModified once", () => {
      const bumpSpy = vi.spyOn(db, "bumpLastModified");
      const oldIds: string[] = [];

      for (let i = 0; i < 55; i += 1) {
        const message = store.sendMessage({
          fromId: `agent-${i}`,
          fromType: "agent",
          toId: `user-${i}`,
          toType: "user",
          content: `bulk-${i}`,
          type: i % 2 === 0 ? "agent-to-user" : "system",
        });
        oldIds.push(message.id);
      }

      const oldTimestamp = new Date(Date.now() - 40 * 86_400_000).toISOString();
      const placeholders = oldIds.map(() => "?").join(", ");
      db.prepare(`UPDATE messages SET updatedAt = ? WHERE id IN (${placeholders})`).run(oldTimestamp, ...oldIds);
      bumpSpy.mockClear();

      const result = store.cleanupOldMessages(7 * 86_400_000);
      expect(result.messagesDeleted).toBe(55);
      expect(bumpSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("getConversation()", () => {
    it("returns all messages between two participants", () => {
      // user-1 sends to agent-1
      store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Hello",
        type: "user-to-agent",
      });

      // agent-1 replies to user-1
      store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Hi there",
        type: "agent-to-user",
      });

      // Unrelated message
      store.sendMessage({
        fromId: "agent-2",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Unrelated",
        type: "agent-to-user",
      });

      const conversation = store.getConversation(
        { id: "user-1", type: "user" },
        { id: "agent-1", type: "agent" },
      );

      expect(conversation).toHaveLength(2);
      // Oldest first
      expect(conversation[0].content).toBe("Hello");
      expect(conversation[1].content).toBe("Hi there");
    });

    it("returns empty array when no conversation exists", () => {
      const conversation = store.getConversation(
        { id: "user-1", type: "user" },
        { id: "agent-99", type: "agent" },
      );
      expect(conversation).toEqual([]);
    });

    it("treats canonical dashboard identity as equivalent to legacy aliases in conversation reads", () => {
      const sent = store.sendMessage({
        fromId: "dashboard",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Question",
        type: "user-to-agent",
      });
      const reply = store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user:dashboard",
        toType: "user",
        content: "Answer",
        type: "agent-to-user",
      });

      const conversation = store.getConversation(
        { id: DASHBOARD_USER_ID, type: "user" },
        { id: "agent-1", type: "agent" },
      );
      expect(conversation.map((message) => message.id)).toEqual([sent.id, reply.id]);
    });
  });

  describe("getMailbox()", () => {
    it("returns mailbox summary with unread count", () => {
      store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Unread 1",
        type: "agent-to-user",
      });

      store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Unread 2",
        type: "agent-to-user",
      });

      const mailbox = store.getMailbox("user-1", "user");

      expect(mailbox.ownerId).toBe("user-1");
      expect(mailbox.ownerType).toBe("user");
      expect(mailbox.unreadCount).toBe(2);
      expect(mailbox.lastMessage).toBeTruthy();
      expect(mailbox.lastMessage!.content).toBe("Unread 2");
    });

    it("returns 0 unread when no messages", () => {
      const mailbox = store.getMailbox("user-99", "user");
      expect(mailbox.unreadCount).toBe(0);
      expect(mailbox.lastMessage).toBeUndefined();
    });

    it("aggregates unread count across canonical and legacy dashboard aliases", () => {
      store.sendMessage({ fromId: "agent-1", fromType: "agent", toId: DASHBOARD_USER_ID, toType: "user", content: "A", type: "agent-to-user" });
      store.sendMessage({ fromId: "agent-1", fromType: "agent", toId: "User: user:dashboard", toType: "user", content: "B", type: "agent-to-user" });

      const mailbox = store.getMailbox(DASHBOARD_USER_ID, "user");
      expect(mailbox.unreadCount).toBe(2);
      expect(mailbox.lastMessage).toBeTruthy();
    });

    it("counts only unread messages", () => {
      const msg1 = store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Will be read",
        type: "agent-to-user",
      });

      store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Stays unread",
        type: "agent-to-user",
      });

      store.markAsRead(msg1.id);

      const mailbox = store.getMailbox("user-1", "user");
      expect(mailbox.unreadCount).toBe(1);
    });
  });

  describe("getAllAgentToAgentMessages() / getUnreadAgentToAgentCount()", () => {
    it("returns newest-first agent-to-agent messages only", () => {
      store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "agent-2",
        toType: "agent",
        content: "first",
        type: "agent-to-agent",
      });
      const second = store.sendMessage({
        fromId: "agent-2",
        fromType: "agent",
        toId: "agent-1",
        toType: "agent",
        content: "second",
        type: "agent-to-agent",
      });
      store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "dashboard",
        toType: "user",
        content: "not included",
        type: "agent-to-user",
      });

      const messages = store.getAllAgentToAgentMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe(second.id);
      expect(messages.every((message) => message.type === "agent-to-agent")).toBe(true);
    });

    it("counts unread agent-to-agent messages only", () => {
      const unread = store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "agent-2",
        toType: "agent",
        content: "unread",
        type: "agent-to-agent",
      });
      const read = store.sendMessage({
        fromId: "agent-2",
        fromType: "agent",
        toId: "agent-1",
        toType: "agent",
        content: "read",
        type: "agent-to-agent",
      });
      store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "dashboard",
        toType: "user",
        content: "non-agent",
        type: "agent-to-user",
      });

      store.markAsRead(read.id);

      expect(store.getUnreadAgentToAgentCount()).toBe(1);
      expect(store.getAllAgentToAgentMessages().map((message) => message.id)).toContain(unread.id);
    });
  });

  describe("events", () => {
    it("emits message:sent event on send", () => {
      const events: Message[] = [];
      store.on("message:sent", (msg) => events.push(msg));

      store.sendMessage({
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

    it("emits message:received event on send", () => {
      const events: Message[] = [];
      store.on("message:received", (msg) => events.push(msg));

      store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Hello",
        type: "user-to-agent",
      });

      expect(events).toHaveLength(1);
    });

    it("emits message:read event on mark as read", () => {
      const events: Message[] = [];
      store.on("message:read", (msg) => events.push(msg));

      const message = store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user-1",
        toType: "user",
        content: "Read me",
        type: "agent-to-user",
      });

      store.markAsRead(message.id);

      expect(events).toHaveLength(1);
      expect(events[0].read).toBe(true);
    });

    it("emits message:deleted event on delete", () => {
      const events: string[] = [];
      store.on("message:deleted", (id) => events.push(id));

      const message = store.sendMessage({
        fromId: "user-1",
        fromType: "user",
        toId: "agent-1",
        toType: "agent",
        content: "Delete me",
        type: "user-to-agent",
      });

      store.deleteMessage(message.id);

      expect(events).toHaveLength(1);
      expect(events[0]).toBe(message.id);
    });
  });

  describe("DASHBOARD_USER_ALIASES — bare 'user' normalization", () => {
    it("normalizeMessageParticipant('user', 'user') normalises to DASHBOARD_USER_ID", () => {
      // Messages sent with to_id='user' (the natural human alias) must be routed to the
      // dashboard mailbox — they should store as toId='dashboard', not 'user'.
      const msg = store.sendMessage({
        fromId: "agent-1",
        fromType: "agent",
        toId: "user",
        toType: "user",
        content: "Inbox test",
        type: "agent-to-user",
      });
      expect(msg.toId).toBe(DASHBOARD_USER_ID);
    });

    it("getInbox('dashboard', 'user') returns messages stored with toId='user'", () => {
      // A message stored while toId='user' was not yet in the alias set must now appear
      // in the operator inbox — validates that the READ path covers the legacy value.
      // We insert directly into the DB (bypassing normalizeMessageParticipant) to simulate
      // messages created by the old code that stored toId='user' rather than 'dashboard'.
      const legacyId = "msg-legacy-test-001";
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO messages (id, fromId, fromType, toId, toType, content, type, read, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(legacyId, "agent-1", "agent", "user", "user", "Legacy DM from old session", "agent-to-user", now, now);

      const inbox = store.getInbox(DASHBOARD_USER_ID, "user");
      const found = inbox.find((m) => m.id === legacyId);
      expect(found).toBeDefined();
      expect(found?.content).toBe("Legacy DM from old session");
    });
  });
});

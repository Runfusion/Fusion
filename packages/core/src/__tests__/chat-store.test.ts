import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChatStore } from "../chat-store.js";
import { Database } from "../db.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-chat-store-test-"));
}

describe("ChatStore", () => {
  let tmpDir: string;
  let kbDir: string;
  let db: Database;
  let store: ChatStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    kbDir = join(tmpDir, ".fusion");
    db = new Database(kbDir);
    db.init();
    store = new ChatStore(kbDir, db);
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Helper Functions ─────────────────────────────────────────────

  function createTestSession(
    store: ChatStore,
    overrides?: Partial<{
      agentId: string;
      title: string | null;
      projectId: string | null;
      modelProvider: string | null;
      modelId: string | null;
    }>,
  ) {
    return store.createSession({
      agentId: overrides?.agentId ?? "agent-001",
      title: overrides?.title ?? "Test Session",
      projectId: overrides?.projectId ?? null,
      modelProvider: overrides?.modelProvider ?? null,
      modelId: overrides?.modelId ?? null,
    });
  }

  // ── Session CRUD Tests ───────────────────────────────────────────

  describe("Session CRUD", () => {
    describe("createSession", () => {
      it("creates a session with correct defaults", () => {
        const session = store.createSession({ agentId: "agent-001" });

        expect(session.id).toMatch(/^chat-/);
        expect(session.agentId).toBe("agent-001");
        expect(session.title).toBeNull();
        expect(session.status).toBe("active");
        expect(session.projectId).toBeNull();
        expect(session.modelProvider).toBeNull();
        expect(session.modelId).toBeNull();
        expect(session.createdAt).toBeTruthy();
        expect(session.updatedAt).toBeTruthy();
      });

      it("stores all provided fields", () => {
        const session = createTestSession(store, {
          agentId: "agent-test",
          title: "My Chat",
          projectId: "proj-123",
          modelProvider: "anthropic",
          modelId: "claude-3",
        });

        expect(session.agentId).toBe("agent-test");
        expect(session.title).toBe("My Chat");
        expect(session.projectId).toBe("proj-123");
        expect(session.modelProvider).toBe("anthropic");
        expect(session.modelId).toBe("claude-3");
      });

      it("generates unique IDs", () => {
        const s1 = store.createSession({ agentId: "agent-001" });
        const s2 = store.createSession({ agentId: "agent-001" });

        expect(s1.id).not.toBe(s2.id);
      });
    });

    describe("getSession", () => {
      it("returns session by id", () => {
        const created = createTestSession(store);
        const retrieved = store.getSession(created.id);

        expect(retrieved).toBeDefined();
        expect(retrieved!.id).toBe(created.id);
        expect(retrieved!.agentId).toBe(created.agentId);
      });

      it("returns undefined for non-existent session", () => {
        const result = store.getSession("chat-nonexistent");
        expect(result).toBeUndefined();
      });
    });

    describe("listSessions", () => {
      it("returns all sessions ordered by updatedAt desc", async () => {
        const s1 = createTestSession(store);
        await new Promise((r) => setTimeout(r, 10));
        const s2 = createTestSession(store);
        await new Promise((r) => setTimeout(r, 10));
        const s3 = createTestSession(store);

        const list = store.listSessions();

        expect(list).toHaveLength(3);
        expect(list[0].id).toBe(s3.id); // Newest first
        expect(list[1].id).toBe(s2.id);
        expect(list[2].id).toBe(s1.id);
      });

      it("filters by projectId", () => {
        createTestSession(store, { projectId: "proj-A" });
        createTestSession(store, { projectId: "proj-B" });
        createTestSession(store, { projectId: "proj-A" });

        const filtered = store.listSessions({ projectId: "proj-A" });

        expect(filtered).toHaveLength(2);
        expect(filtered.every((s) => s.projectId === "proj-A")).toBe(true);
      });

      it("filters by agentId", () => {
        createTestSession(store, { agentId: "agent-A" });
        createTestSession(store, { agentId: "agent-B" });
        createTestSession(store, { agentId: "agent-A" });

        const filtered = store.listSessions({ agentId: "agent-A" });

        expect(filtered).toHaveLength(2);
        expect(filtered.every((s) => s.agentId === "agent-A")).toBe(true);
      });

      it("filters by status", () => {
        createTestSession(store);
        const archived = createTestSession(store);
        store.archiveSession(archived.id);

        const activeSessions = store.listSessions({ status: "active" });
        const archivedSessions = store.listSessions({ status: "archived" });

        expect(activeSessions).toHaveLength(1);
        expect(archivedSessions).toHaveLength(1);
        expect(archivedSessions[0].status).toBe("archived");
      });

      it("returns empty array when no sessions", () => {
        const list = store.listSessions();
        expect(list).toHaveLength(0);
      });

      it("combines multiple filters", () => {
        createTestSession(store, { agentId: "agent-A", projectId: "proj-A" });
        createTestSession(store, { agentId: "agent-A", projectId: "proj-B" });
        createTestSession(store, { agentId: "agent-B", projectId: "proj-A" });

        const filtered = store.listSessions({ agentId: "agent-A", projectId: "proj-A" });

        expect(filtered).toHaveLength(1);
        expect(filtered[0].agentId).toBe("agent-A");
        expect(filtered[0].projectId).toBe("proj-A");
      });
    });

    describe("updateSession", () => {
      it("updates title and bumps updatedAt", async () => {
        const session = createTestSession(store);
        const originalUpdatedAt = session.updatedAt;

        await new Promise((r) => setTimeout(r, 5));

        const updated = store.updateSession(session.id, { title: "Updated Title" });

        expect(updated).toBeDefined();
        expect(updated!.title).toBe("Updated Title");
        expect(updated!.id).toBe(session.id);
        expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(
          new Date(originalUpdatedAt).getTime(),
        );
      });

      it("updates status", () => {
        const session = createTestSession(store);
        const updated = store.updateSession(session.id, { status: "archived" });

        expect(updated!.status).toBe("archived");
      });

      it("updates model fields", () => {
        const session = createTestSession(store);
        const updated = store.updateSession(session.id, {
          modelProvider: "openai",
          modelId: "gpt-4o",
        });

        expect(updated!.modelProvider).toBe("openai");
        expect(updated!.modelId).toBe("gpt-4o");
      });

      it("returns undefined for non-existent session", () => {
        const result = store.updateSession("chat-nonexistent", { title: "Test" });
        expect(result).toBeUndefined();
      });

      it("can clear fields by setting to null", () => {
        const session = createTestSession(store, {
          title: "Has title",
          modelProvider: "anthropic",
          modelId: "claude",
        });

        const updated = store.updateSession(session.id, {
          title: null,
          modelProvider: null,
          modelId: null,
        });

        expect(updated!.title).toBeNull();
        expect(updated!.modelProvider).toBeNull();
        expect(updated!.modelId).toBeNull();
      });
    });

    describe("archiveSession", () => {
      it("sets status to archived", () => {
        const session = createTestSession(store);
        const archived = store.archiveSession(session.id);

        expect(archived!.status).toBe("archived");
      });

      it("returns undefined for non-existent session", () => {
        const result = store.archiveSession("chat-nonexistent");
        expect(result).toBeUndefined();
      });
    });

    describe("deleteSession", () => {
      it("removes session from database", () => {
        const session = createTestSession(store);
        const deleted = store.deleteSession(session.id);

        expect(deleted).toBe(true);
        expect(store.getSession(session.id)).toBeUndefined();
      });

      it("returns false for non-existent session", () => {
        const result = store.deleteSession("chat-nonexistent");
        expect(result).toBe(false);
      });

      it("cascades to delete messages", () => {
        const session = createTestSession(store);
        store.addMessage(session.id, { role: "user", content: "Hello" });
        store.addMessage(session.id, { role: "assistant", content: "Hi there" });

        expect(store.getMessages(session.id)).toHaveLength(2);

        store.deleteSession(session.id);

        expect(store.getMessages(session.id)).toHaveLength(0);
        expect(store.getSession(session.id)).toBeUndefined();
      });
    });
  });

  // ── Message CRUD Tests ───────────────────────────────────────────

  describe("Message CRUD", () => {
    describe("addMessage", () => {
      it("creates message with correct fields", () => {
        const session = createTestSession(store);
        const message = store.addMessage(session.id, {
          role: "user",
          content: "Hello, agent!",
        });

        expect(message.id).toMatch(/^msg-/);
        expect(message.sessionId).toBe(session.id);
        expect(message.role).toBe("user");
        expect(message.content).toBe("Hello, agent!");
        expect(message.thinkingOutput).toBeNull();
        expect(message.metadata).toBeNull();
        expect(message.createdAt).toBeTruthy();
      });

      it("stores thinkingOutput when provided", () => {
        const session = createTestSession(store);
        const message = store.addMessage(session.id, {
          role: "assistant",
          content: "I think the best approach is...",
          thinkingOutput: "Let me reason through this step by step...",
        });

        expect(message.thinkingOutput).toBe("Let me reason through this step by step...");
      });

      it("stores metadata when provided", () => {
        const session = createTestSession(store);
        const message = store.addMessage(session.id, {
          role: "assistant",
          content: "Here's my response",
          metadata: { tokens: 150, finishReason: "stop" },
        });

        expect(message.metadata).toEqual({ tokens: 150, finishReason: "stop" });
      });

      it("throws error when session does not exist", () => {
        expect(() => {
          store.addMessage("chat-nonexistent", {
            role: "user",
            content: "Hello",
          });
        }).toThrow("Chat session chat-nonexistent not found");
      });

      it("updates session's updatedAt timestamp", async () => {
        const session = createTestSession(store);
        const originalUpdatedAt = session.updatedAt;

        await new Promise((r) => setTimeout(r, 5));

        store.addMessage(session.id, { role: "user", content: "New message" });

        const updated = store.getSession(session.id)!;
        expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
          new Date(originalUpdatedAt).getTime(),
        );
      });
    });

    describe("getMessages", () => {
      it("returns messages for a session ordered by createdAt ASC", async () => {
        const session = createTestSession(store);
        const m1 = store.addMessage(session.id, { role: "user", content: "First" });
        await new Promise((r) => setTimeout(r, 5));
        const m2 = store.addMessage(session.id, { role: "assistant", content: "Second" });
        await new Promise((r) => setTimeout(r, 5));
        const m3 = store.addMessage(session.id, { role: "user", content: "Third" });

        const messages = store.getMessages(session.id);

        expect(messages).toHaveLength(3);
        expect(messages[0].id).toBe(m1.id);
        expect(messages[1].id).toBe(m2.id);
        expect(messages[2].id).toBe(m3.id);
      });

      it("respects limit", () => {
        const session = createTestSession(store);
        store.addMessage(session.id, { role: "user", content: "1" });
        store.addMessage(session.id, { role: "user", content: "2" });
        store.addMessage(session.id, { role: "user", content: "3" });

        const messages = store.getMessages(session.id, { limit: 2 });

        expect(messages).toHaveLength(2);
      });

      it("respects offset", () => {
        const session = createTestSession(store);
        store.addMessage(session.id, { role: "user", content: "1" });
        store.addMessage(session.id, { role: "user", content: "2" });
        store.addMessage(session.id, { role: "user", content: "3" });

        const messages = store.getMessages(session.id, { offset: 1 });

        expect(messages).toHaveLength(2);
        expect(messages[0].content).toBe("2");
      });

      it("respects before cursor (timestamp)", async () => {
        const session = createTestSession(store);
        const m1 = store.addMessage(session.id, { role: "user", content: "1" });
        await new Promise((r) => setTimeout(r, 5));
        store.addMessage(session.id, { role: "user", content: "2" });
        await new Promise((r) => setTimeout(r, 5));
        store.addMessage(session.id, { role: "user", content: "3" });

        const messages = store.getMessages(session.id, { before: m1.createdAt });

        // Should return messages created before m1 (none in this case)
        expect(messages).toHaveLength(0);
      });

      it("combines limit and offset", () => {
        const session = createTestSession(store);
        store.addMessage(session.id, { role: "user", content: "1" });
        store.addMessage(session.id, { role: "user", content: "2" });
        store.addMessage(session.id, { role: "user", content: "3" });
        store.addMessage(session.id, { role: "user", content: "4" });

        const messages = store.getMessages(session.id, { limit: 2, offset: 1 });

        expect(messages).toHaveLength(2);
        expect(messages[0].content).toBe("2");
        expect(messages[1].content).toBe("3");
      });

      it("returns empty array for session with no messages", () => {
        const session = createTestSession(store);
        const messages = store.getMessages(session.id);
        expect(messages).toHaveLength(0);
      });

      it("returns empty array for non-existent session", () => {
        const messages = store.getMessages("chat-nonexistent");
        expect(messages).toHaveLength(0);
      });
    });

    describe("getMessage", () => {
      it("returns message by id", () => {
        const session = createTestSession(store);
        const created = store.addMessage(session.id, {
          role: "user",
          content: "Test message",
        });

        const retrieved = store.getMessage(created.id);

        expect(retrieved).toBeDefined();
        expect(retrieved!.id).toBe(created.id);
        expect(retrieved!.content).toBe("Test message");
      });

      it("returns undefined for non-existent message", () => {
        const result = store.getMessage("msg-nonexistent");
        expect(result).toBeUndefined();
      });
    });

    describe("getLastMessageForSessions", () => {
      it("returns the most recent message for each session", async () => {
        const session1 = createTestSession(store);
        const session2 = createTestSession(store);

        // Add messages to session1
        store.addMessage(session1.id, { role: "user", content: "Hello" });
        await new Promise((r) => setTimeout(r, 5));
        const latestMsg1 = store.addMessage(session1.id, {
          role: "assistant",
          content: "Latest for session 1",
        });

        // Add only one message to session2
        const latestMsg2 = store.addMessage(session2.id, {
          role: "assistant",
          content: "Latest for session 2",
        });

        const result = store.getLastMessageForSessions([session1.id, session2.id]);

        expect(result.size).toBe(2);
        expect(result.get(session1.id)).toBeDefined();
        expect(result.get(session1.id)!.content).toBe("Latest for session 1");
        expect(result.get(session2.id)).toBeDefined();
        expect(result.get(session2.id)!.content).toBe("Latest for session 2");
      });

      it("handles empty session list", () => {
        const result = store.getLastMessageForSessions([]);
        expect(result.size).toBe(0);
      });

      it("handles sessions with no messages", () => {
        const session1 = createTestSession(store);
        const session2 = createTestSession(store);

        // Only add message to session1
        store.addMessage(session1.id, { role: "user", content: "Hello" });

        const result = store.getLastMessageForSessions([session1.id, session2.id]);

        expect(result.size).toBe(1);
        expect(result.has(session1.id)).toBe(true);
        expect(result.has(session2.id)).toBe(false);
      });

      it("handles non-existent session IDs", () => {
        const session = createTestSession(store);
        store.addMessage(session.id, { role: "user", content: "Hello" });

        const result = store.getLastMessageForSessions([
          session.id,
          "non-existent-1",
          "non-existent-2",
        ]);

        expect(result.size).toBe(1);
        expect(result.has(session.id)).toBe(true);
      });
    });

    describe("deleteMessage", () => {
      it("deletes an existing message and returns true", () => {
        const session = createTestSession(store);
        const message = store.addMessage(session.id, { role: "user", content: "Hello" });

        expect(store.getMessage(message.id)).toBeDefined();

        const result = store.deleteMessage(message.id);

        expect(result).toBe(true);
        expect(store.getMessage(message.id)).toBeUndefined();
      });

      it("returns false for non-existent message", () => {
        const result = store.deleteMessage("msg-nonexistent");
        expect(result).toBe(false);
      });

      it("removes message from session's message list", () => {
        const session = createTestSession(store);
        store.addMessage(session.id, { role: "user", content: "Hello" });
        const msg2 = store.addMessage(session.id, { role: "assistant", content: "Hi" });

        expect(store.getMessages(session.id)).toHaveLength(2);

        store.deleteMessage(msg2.id);

        expect(store.getMessages(session.id)).toHaveLength(1);
        expect(store.getMessages(session.id)[0].content).toBe("Hello");
      });

      it("does not delete messages from other sessions", () => {
        const session1 = createTestSession(store);
        const session2 = createTestSession(store);
        const msg1 = store.addMessage(session1.id, { role: "user", content: "Session 1" });
        store.addMessage(session2.id, { role: "user", content: "Session 2" });

        store.deleteMessage(msg1.id);

        expect(store.getMessages(session1.id)).toHaveLength(0);
        expect(store.getMessages(session2.id)).toHaveLength(1);
        expect(store.getMessages(session2.id)[0].content).toBe("Session 2");
      });

      it("updates the parent session's updatedAt timestamp", async () => {
        const session = createTestSession(store);
        store.addMessage(session.id, { role: "user", content: "Hello" });
        const originalUpdatedAt = store.getSession(session.id)!.updatedAt;

        await new Promise((r) => setTimeout(r, 5));

        const msg = store.addMessage(session.id, { role: "assistant", content: "Reply" });
        const afterAddUpdatedAt = store.getSession(session.id)!.updatedAt;

        await new Promise((r) => setTimeout(r, 5));

        store.deleteMessage(msg.id);

        const afterDeleteUpdatedAt = store.getSession(session.id)!.updatedAt;

        // The updatedAt should be newer after adding and after deleting
        expect(new Date(afterAddUpdatedAt).getTime()).toBeGreaterThan(
          new Date(originalUpdatedAt).getTime(),
        );
        expect(new Date(afterDeleteUpdatedAt).getTime()).toBeGreaterThan(
          new Date(afterAddUpdatedAt).getTime(),
        );
      });
    });
  });

  // ── Event Emission Tests ─────────────────────────────────────────

  describe("Event emission", () => {
    it("createSession emits chat:session:created", () => {
      const handler = vi.fn();
      store.on("chat:session:created", handler);

      const session = store.createSession({ agentId: "agent-001" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(session);
    });

    it("updateSession emits chat:session:updated", () => {
      const handler = vi.fn();
      store.on("chat:session:updated", handler);

      const session = createTestSession(store);
      const updated = store.updateSession(session.id, { title: "Updated" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(updated);
    });

    it("deleteSession emits chat:session:deleted", () => {
      const handler = vi.fn();
      store.on("chat:session:deleted", handler);

      const session = createTestSession(store);
      store.deleteSession(session.id);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(session.id);
    });

    it("deleteSession does NOT emit for non-existent session", () => {
      const handler = vi.fn();
      store.on("chat:session:deleted", handler);

      store.deleteSession("chat-nonexistent");

      expect(handler).not.toHaveBeenCalled();
    });

    it("addMessage emits chat:message:added", () => {
      const handler = vi.fn();
      store.on("chat:message:added", handler);

      const session = createTestSession(store);
      const message = store.addMessage(session.id, { role: "user", content: "Hello" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(message);
    });

    it("deleteMessage emits chat:message:deleted", () => {
      const handler = vi.fn();
      store.on("chat:message:deleted", handler);

      const session = createTestSession(store);
      const message = store.addMessage(session.id, { role: "user", content: "Hello" });
      handler.mockClear();

      store.deleteMessage(message.id);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(message.id);
    });

    it("deleteMessage emits chat:session:updated for the parent session", () => {
      const handler = vi.fn();
      store.on("chat:session:updated", handler);

      const session = createTestSession(store);
      const message = store.addMessage(session.id, { role: "user", content: "Hello" });
      handler.mockClear();

      store.deleteMessage(message.id);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].id).toBe(session.id);
    });

    it("deleteMessage does NOT emit for non-existent message", () => {
      const handler = vi.fn();
      store.on("chat:message:deleted", handler);

      store.deleteMessage("msg-nonexistent");

      expect(handler).not.toHaveBeenCalled();
    });

    it("deleteMessage does NOT emit chat:session:updated for non-existent message", () => {
      const handler = vi.fn();
      store.on("chat:session:updated", handler);

      store.deleteMessage("msg-nonexistent");

      expect(handler).not.toHaveBeenCalled();
    });

    it("archiveSession emits chat:session:updated", () => {
      const handler = vi.fn();
      store.on("chat:session:updated", handler);

      const session = createTestSession(store);
      store.archiveSession(session.id);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].status).toBe("archived");
    });
  });
});

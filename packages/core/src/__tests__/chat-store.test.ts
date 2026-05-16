import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
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
  let fusionDir: string;
  let db: Database;
  let store: ChatStore;

  const resetChatTablesSql = `
    DELETE FROM chat_room_messages;
    DELETE FROM chat_room_members;
    DELETE FROM chat_rooms;
    DELETE FROM chat_messages;
    DELETE FROM chat_sessions;
  `;

  beforeAll(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");

    // Reuse a single initialized in-memory DB + ChatStore for the file.
    // ChatStore does not cache per-test state or prepared statements; each method prepares on demand.
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new ChatStore(fusionDir, db);
  });

  beforeEach(() => {
    db.exec(resetChatTablesSql);
    store.removeAllListeners();
  });

  afterEach(() => {
    vi.useRealTimers();
    store.removeAllListeners();
  });

  afterAll(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }

    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Helper Functions ─────────────────────────────────────────────

  function startFakeClock() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  }

  function advanceClock(ms = 1) {
    vi.setSystemTime(new Date(Date.now() + ms));
  }

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
        expect(session.inFlightGeneration).toBeNull();
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
      it("returns all sessions ordered by updatedAt desc", () => {
        startFakeClock();
        const s1 = createTestSession(store);
        advanceClock(10);
        const s2 = createTestSession(store);
        advanceClock(10);
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

    describe("findLatestActiveSessionForTarget", () => {
      it("returns newest exact model match for model-specific targets", () => {
        startFakeClock();
        const olderModelMatch = createTestSession(store, {
          agentId: "agent-lookup",
          projectId: "proj-1",
          modelProvider: "openai",
          modelId: "gpt-4o",
        });
        advanceClock(5);
        const newestModelMatch = createTestSession(store, {
          agentId: "agent-lookup",
          projectId: "proj-1",
          modelProvider: "openai",
          modelId: "gpt-4o",
        });

        createTestSession(store, {
          agentId: "agent-lookup",
          projectId: "proj-1",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
        });

        const found = store.findLatestActiveSessionForTarget({
          projectId: "proj-1",
          agentId: "agent-lookup",
          modelProvider: "openai",
          modelId: "gpt-4o",
        });

        expect(found?.id).toBe(newestModelMatch.id);
        expect(found?.id).not.toBe(olderModelMatch.id);
      });

      it("prefers model-less session for agent-only targets", () => {
        startFakeClock();
        const modelSpecific = createTestSession(store, {
          agentId: "agent-lookup",
          projectId: "proj-1",
          modelProvider: "openai",
          modelId: "gpt-4o",
        });
        advanceClock(5);
        const modelLess = createTestSession(store, {
          agentId: "agent-lookup",
          projectId: "proj-1",
        });

        const found = store.findLatestActiveSessionForTarget({
          projectId: "proj-1",
          agentId: "agent-lookup",
        });

        expect(found?.id).toBe(modelLess.id);
        expect(found?.id).not.toBe(modelSpecific.id);
      });

      it("falls back to newest agent session when no model-less session exists", () => {
        startFakeClock();
        createTestSession(store, {
          agentId: "agent-lookup",
          projectId: "proj-1",
          modelProvider: "openai",
          modelId: "gpt-4o-mini",
        });
        advanceClock(5);
        const newestModelSpecific = createTestSession(store, {
          agentId: "agent-lookup",
          projectId: "proj-1",
          modelProvider: "openai",
          modelId: "gpt-4o",
        });

        const found = store.findLatestActiveSessionForTarget({
          projectId: "proj-1",
          agentId: "agent-lookup",
        });

        expect(found?.id).toBe(newestModelSpecific.id);
      });

      it("returns undefined when there is no matching active session", () => {
        createTestSession(store, {
          agentId: "agent-lookup",
          projectId: "proj-1",
        });

        const found = store.findLatestActiveSessionForTarget({
          projectId: "proj-2",
          agentId: "agent-lookup",
        });

        expect(found).toBeUndefined();
      });

      it("throws for inconsistent model-provider query pairs", () => {
        expect(() =>
          store.findLatestActiveSessionForTarget({
            projectId: "proj-1",
            agentId: "agent-lookup",
            modelProvider: "openai",
          }),
        ).toThrow("modelProvider and modelId must both be provided together, or neither");
      });
    });

    describe("updateSession", () => {
      it("updates title and bumps updatedAt", () => {
        startFakeClock();
        const session = createTestSession(store);
        const originalUpdatedAt = session.updatedAt;

        advanceClock(5);

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

    describe("setInFlightGeneration", () => {
      it("persists and clears in-flight generation snapshot", () => {
        const session = createTestSession(store);

        const updated = store.setInFlightGeneration(session.id, {
          status: "generating",
          streamingText: "partial",
          streamingThinking: "thinking",
          toolCalls: [{ toolName: "read", isError: false, status: "running" }],
          replayFromEventId: 12,
          updatedAt: new Date().toISOString(),
        });

        expect(updated?.inFlightGeneration?.streamingText).toBe("partial");
        expect(store.getSession(session.id)?.inFlightGeneration?.replayFromEventId).toBe(12);

        store.setInFlightGeneration(session.id, null);
        expect(store.getSession(session.id)?.inFlightGeneration).toBeNull();
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

      it("round-trips attachments metadata", () => {
        const session = createTestSession(store);
        const attachments = [{
          id: "att-abc123",
          filename: "123-file.png",
          originalName: "file.png",
          mimeType: "image/png",
          size: 1024,
          createdAt: new Date().toISOString(),
        }];

        const created = store.addMessage(session.id, {
          role: "user",
          content: "with attachment",
          attachments,
        });

        expect(created.attachments).toEqual(attachments);
        const loaded = store.getMessage(created.id);
        expect(loaded?.attachments).toEqual(attachments);
      });

      it("returns undefined attachments when not provided", () => {
        const session = createTestSession(store);
        const created = store.addMessage(session.id, {
          role: "user",
          content: "without attachment",
        });

        expect(created.attachments).toBeUndefined();
      });

      it("throws error when session does not exist", () => {
        expect(() => {
          store.addMessage("chat-nonexistent", {
            role: "user",
            content: "Hello",
          });
        }).toThrow("Chat session chat-nonexistent not found");
      });

      it("updates session's updatedAt timestamp", () => {
        startFakeClock();
        const session = createTestSession(store);
        const originalUpdatedAt = session.updatedAt;

        advanceClock(5);

        store.addMessage(session.id, { role: "user", content: "New message" });

        const updated = store.getSession(session.id)!;
        expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
          new Date(originalUpdatedAt).getTime(),
        );
      });
    });

    describe("addMessageAttachment", () => {
      it("appends to existing attachments", () => {
        const session = createTestSession(store);
        const message = store.addMessage(session.id, {
          role: "user",
          content: "hello",
          attachments: [{
            id: "att-1",
            filename: "a.txt",
            originalName: "a.txt",
            mimeType: "text/plain",
            size: 1,
            createdAt: new Date().toISOString(),
          }],
        });

        const updated = store.addMessageAttachment(session.id, message.id, {
          id: "att-2",
          filename: "b.txt",
          originalName: "b.txt",
          mimeType: "text/plain",
          size: 2,
          createdAt: new Date().toISOString(),
        });

        expect(updated.attachments).toHaveLength(2);
        expect(updated.attachments?.[1]?.id).toBe("att-2");
      });

      it("creates attachment array when message has none", () => {
        const session = createTestSession(store);
        const message = store.addMessage(session.id, { role: "user", content: "hello" });

        const updated = store.addMessageAttachment(session.id, message.id, {
          id: "att-3",
          filename: "c.txt",
          originalName: "c.txt",
          mimeType: "text/plain",
          size: 3,
          createdAt: new Date().toISOString(),
        });

        expect(updated.attachments).toHaveLength(1);
        expect(updated.attachments?.[0]?.id).toBe("att-3");
      });
    });

    describe("getMessages", () => {
      it("returns messages for a session ordered by createdAt ASC", () => {
        startFakeClock();
        const session = createTestSession(store);
        const m1 = store.addMessage(session.id, { role: "user", content: "First" });
        advanceClock(5);
        const m2 = store.addMessage(session.id, { role: "assistant", content: "Second" });
        advanceClock(5);
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

      it("respects before cursor (timestamp)", () => {
        startFakeClock();
        const session = createTestSession(store);
        const m1 = store.addMessage(session.id, { role: "user", content: "1" });
        advanceClock(5);
        store.addMessage(session.id, { role: "user", content: "2" });
        advanceClock(5);
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
      it("returns the most recent message for each session", () => {
        startFakeClock();
        const session1 = createTestSession(store);
        const session2 = createTestSession(store);

        // Add messages to session1
        store.addMessage(session1.id, { role: "user", content: "Hello" });
        advanceClock(5);
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

      it("updates the parent session's updatedAt timestamp", () => {
        startFakeClock();
        const session = createTestSession(store);
        store.addMessage(session.id, { role: "user", content: "Hello" });
        const originalUpdatedAt = store.getSession(session.id)!.updatedAt;

        advanceClock(5);

        const msg = store.addMessage(session.id, { role: "assistant", content: "Reply" });
        const afterAddUpdatedAt = store.getSession(session.id)!.updatedAt;

        advanceClock(5);

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

  // ── Room CRUD Tests ───────────────────────────────────────────

  describe("Room CRUD", () => {
    it("creates room with normalized slug and member list", () => {
      const room = store.createRoom({
        name: "#Engineering Team",
        projectId: "proj-1",
        createdBy: "agent-owner",
        memberAgentIds: ["agent-owner", "agent-2"],
      });

      expect(room.id).toMatch(/^room-/);
      expect(room.name).toBe("Engineering Team");
      expect(room.slug).toBe("engineering-team");

      const members = store.listRoomMembers(room.id);
      expect(members).toHaveLength(2);
      expect(members.find((m) => m.agentId === "agent-owner")?.role).toBe("owner");
    });

    it("rejects slug collision in same project and allows across projects", () => {
      store.createRoom({ name: "engineering", projectId: "proj-1" });
      expect(() => store.createRoom({ name: "#Engineering", projectId: "proj-1" })).toThrow(
        "already exists",
      );
      expect(() => store.createRoom({ name: "#Engineering", projectId: "proj-2" })).not.toThrow();
    });

    it("supports get list update delete and member operations", () => {
      const room = store.createRoom({ name: "general", projectId: "proj-1", createdBy: "agent-1" });
      expect(store.getRoom(room.id)?.id).toBe(room.id);
      expect(store.getRoomBySlug("proj-1", "general")?.id).toBe(room.id);
      expect(store.listRooms({ projectId: "proj-1" })).toHaveLength(1);

      const updated = store.updateRoom(room.id, { name: "#General Chat", description: "main", status: "archived" });
      expect(updated?.slug).toBe("general-chat");
      expect(updated?.status).toBe("archived");

      const added = store.addRoomMember(room.id, "agent-2");
      const addedAgain = store.addRoomMember(room.id, "agent-2");
      expect(added.agentId).toBe("agent-2");
      expect(addedAgain.agentId).toBe("agent-2");
      expect(store.listRoomMembers(room.id).filter((m) => m.agentId === "agent-2")).toHaveLength(1);

      expect(store.listRoomsForAgent("agent-2", { projectId: "proj-1", status: "archived" })).toHaveLength(1);
      expect(store.removeRoomMember(room.id, "agent-2")).toBe(true);
      expect(store.removeRoomMember(room.id, "agent-2")).toBe(false);

      expect(store.deleteRoom(room.id)).toBe(true);
      expect(store.getRoom(room.id)).toBeUndefined();
    });

    it("cascades member and message deletion with room delete", () => {
      const room = store.createRoom({ name: "ops", projectId: "proj-1" });
      store.addRoomMember(room.id, "agent-1");
      store.addRoomMessage(room.id, { role: "user", content: "hello", mentions: ["agent-1"] });

      store.deleteRoom(room.id);

      expect(store.listRoomMembers(room.id)).toHaveLength(0);
      expect(store.getRoomMessages(room.id)).toHaveLength(0);
    });
  });

  describe("Room messages", () => {
    it("adds and lists room messages with before cursor, mentions, and attachment append", () => {
      startFakeClock();
      const room = store.createRoom({ name: "support", projectId: "proj-1" });
      const first = store.addRoomMessage(room.id, { role: "user", content: "first", mentions: ["agent-1"] });
      advanceClock(5);
      const second = store.addRoomMessage(room.id, { role: "assistant", content: "second", senderAgentId: "agent-1" });

      const loadedFirst = store.getRoomMessage(first.id);
      expect(loadedFirst?.mentions).toEqual(["agent-1"]);

      const beforeList = store.getRoomMessages(room.id, { before: second.createdAt });
      expect(beforeList.map((m) => m.id)).toEqual([first.id]);

      const updated = store.addRoomMessageAttachment(room.id, second.id, {
        id: "att-room",
        filename: "room.txt",
        originalName: "room.txt",
        mimeType: "text/plain",
        size: 10,
        createdAt: new Date().toISOString(),
      });
      expect(updated.attachments).toHaveLength(1);
    });

    it("deleteRoomMessage emits event and bumps room updatedAt", () => {
      startFakeClock();
      const deletedHandler = vi.fn();
      store.on("chat:room:message:deleted", deletedHandler);

      const room = store.createRoom({ name: "alerts", projectId: "proj-1" });
      const msg = store.addRoomMessage(room.id, { role: "user", content: "hello" });
      const afterAdd = store.getRoom(room.id)!;
      advanceClock(5);

      expect(store.deleteRoomMessage(msg.id)).toBe(true);
      const afterDelete = store.getRoom(room.id)!;

      expect(deletedHandler).toHaveBeenCalledWith(msg.id);
      expect(new Date(afterDelete.updatedAt).getTime()).toBeGreaterThan(new Date(afterAdd.updatedAt).getTime());
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

    it("addMessageAttachment emits chat:message:updated", () => {
      const handler = vi.fn();
      store.on("chat:message:updated", handler);

      const session = createTestSession(store);
      const message = store.addMessage(session.id, { role: "user", content: "hello" });

      const updated = store.addMessageAttachment(session.id, message.id, {
        id: "att-evt",
        filename: "evt.txt",
        originalName: "evt.txt",
        mimeType: "text/plain",
        size: 4,
        createdAt: new Date().toISOString(),
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(updated);
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

    it("emits room lifecycle and message events", () => {
      const createdHandler = vi.fn();
      const memberAddedHandler = vi.fn();
      const messageAddedHandler = vi.fn();
      const roomDeletedHandler = vi.fn();
      store.on("chat:room:created", createdHandler);
      store.on("chat:room:member:added", memberAddedHandler);
      store.on("chat:room:message:added", messageAddedHandler);
      store.on("chat:room:deleted", roomDeletedHandler);

      const room = store.createRoom({
        name: "eng",
        projectId: "proj-1",
        memberAgentIds: ["agent-1"],
      });
      store.addRoomMessage(room.id, { role: "user", content: "hi" });
      store.deleteRoom(room.id);

      expect(createdHandler).toHaveBeenCalledWith(room);
      expect(memberAddedHandler).toHaveBeenCalledTimes(1);
      expect(messageAddedHandler).toHaveBeenCalledTimes(1);
      expect(roomDeletedHandler).toHaveBeenCalledWith(room.id);
    });
  });

  describe("cleanupOldChats", () => {
    it("deletes stale sessions/rooms, cascades messages, and emits deleted events", () => {
      startFakeClock();
      const deletedSessionEvents: string[] = [];
      const deletedRoomEvents: string[] = [];
      store.on("chat:session:deleted", (id) => deletedSessionEvents.push(id));
      store.on("chat:room:deleted", (id) => deletedRoomEvents.push(id));

      const staleSession = createTestSession(store, { title: "stale" });
      const staleSessionMessage = store.addMessage(staleSession.id, { role: "user", content: "old session msg" });
      const staleRoom = store.createRoom({ name: "old room", projectId: "proj-1" });
      const staleRoomMessage = store.addRoomMessage(staleRoom.id, { role: "user", content: "old room msg" });

      advanceClock(3 * 24 * 60 * 60 * 1000);

      const freshSession = createTestSession(store, { title: "fresh" });
      const freshSessionMessage = store.addMessage(freshSession.id, { role: "user", content: "new session msg" });
      const freshRoom = store.createRoom({ name: "fresh room", projectId: "proj-1" });
      const freshRoomMessage = store.addRoomMessage(freshRoom.id, { role: "user", content: "new room msg" });

      const staleTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const freshTimestamp = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(staleTimestamp, staleSession.id);
      db.prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(staleTimestamp, staleRoom.id);
      db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(freshTimestamp, freshSession.id);
      db.prepare("UPDATE chat_rooms SET updatedAt = ? WHERE id = ?").run(freshTimestamp, freshRoom.id);

      const result = store.cleanupOldChats(7 * 24 * 60 * 60 * 1000);

      expect(result).toEqual({ sessionsDeleted: 1, roomsDeleted: 1 });
      expect(store.getSession(staleSession.id)).toBeUndefined();
      expect(store.getRoom(staleRoom.id)).toBeUndefined();
      expect(store.getSession(freshSession.id)).toBeDefined();
      expect(store.getRoom(freshRoom.id)).toBeDefined();

      expect(store.getMessage(staleSessionMessage.id)).toBeUndefined();
      expect(store.getRoomMessage(staleRoomMessage.id)).toBeUndefined();
      expect(store.getMessage(freshSessionMessage.id)).toBeDefined();
      expect(store.getRoomMessage(freshRoomMessage.id)).toBeDefined();

      expect(deletedSessionEvents).toContain(staleSession.id);
      expect(deletedRoomEvents).toContain(staleRoom.id);
      expect(deletedSessionEvents).not.toContain(freshSession.id);
      expect(deletedRoomEvents).not.toContain(freshRoom.id);
    });

    it("returns no-op for non-positive maxAgeMs", () => {
      const session = createTestSession(store);
      const room = store.createRoom({ name: "noop-room", projectId: "proj-1" });

      expect(store.cleanupOldChats(0)).toEqual({ sessionsDeleted: 0, roomsDeleted: 0 });
      expect(store.cleanupOldChats(-10)).toEqual({ sessionsDeleted: 0, roomsDeleted: 0 });
      expect(store.cleanupOldChats(Number.NaN)).toEqual({ sessionsDeleted: 0, roomsDeleted: 0 });

      expect(store.getSession(session.id)).toBeDefined();
      expect(store.getRoom(room.id)).toBeDefined();
    });
  });

  describe("Test isolation", () => {
    it("starts with no leaked sessions from prior tests", () => {
      expect(store.listSessions()).toEqual([]);
    });
  });
});

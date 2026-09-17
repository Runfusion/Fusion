/*
FNXC:ChatMessageEdit 2026-09-16-05:58:
FN-459. Editing a just-sent chat message failed with `Message temp-<ts> not found in session <sid>`
because the persisted identity of the user turn reached the client only through the out-of-band
`chat:message:added` echo, which is not a reliable channel. These tests pin the in-band contract:
`ChatManager.sendMessage` broadcasts a `user_message` stream event carrying the PERSISTED row as
soon as it exists — before any early return, including the mentions dispatch path — and a hostile
broadcast sink can never fail the accepted send. The last case pins that the server-side 404 guard
in `prepareReplacement` is NOT weakened; it simply stops being reachable from the UI.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  ChatManager,
  chatStreamManager,
  __resetChatState,
  __setCreateResolvedAgentSession,
  type ChatStreamEvent,
} from "../chat.js";
import type { ChatMessage, ChatSession } from "@fusion/core";

/**
 * Minimal in-memory stand-in for the async ChatStore surface `ChatManager.sendMessage` touches.
 * Message ids deliberately use the authoritative persisted shape (`msg-<n>`) produced by
 * `ChatStore.addMessage`, because the whole point of this seam is that the client receives a
 * PERSISTED id rather than its local `temp-<ts>` placeholder.
 */
class FakeChatStore {
  sessions = new Map<string, ChatSession>();
  messages: ChatMessage[] = [];
  private counter = 0;

  createSession(overrides: Partial<ChatSession> = {}): ChatSession {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: `chat-${++this.counter}`,
      agentId: "agent-001",
      title: "Existing title",
      status: "active",
      projectId: null,
      modelProvider: null,
      modelId: null,
      cliSessionFile: null,
      cliExecutorAdapterId: null,
      inFlightGeneration: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } as ChatSession;
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(id: string): Promise<ChatSession | undefined> {
    return this.sessions.get(id);
  }

  async setInFlightGeneration(): Promise<void> { /* irrelevant to the identity seam */ }
  async setCliSessionFile(id: string, cliSessionFile: string | null): Promise<void> {
    const session = this.sessions.get(id);
    if (session) session.cliSessionFile = cliSessionFile;
  }

  async addMessage(
    sessionId: string,
    input: { role: "user" | "assistant"; content: string; thinkingOutput?: string; metadata?: Record<string, unknown> },
  ): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: `msg-${++this.counter}`,
      sessionId,
      role: input.role,
      content: input.content,
      thinkingOutput: input.thinkingOutput ?? null,
      metadata: input.metadata ?? null,
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    return message;
  }

  async getMessage(id: string): Promise<ChatMessage | undefined> {
    return this.messages.find((message) => message.id === id);
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.messages.filter((message) => message.sessionId === sessionId);
  }

  async updateMessageMetadata(messageId: string, metadata: Record<string, unknown> | null): Promise<ChatMessage> {
    const existing = this.messages.find((message) => message.id === messageId);
    if (!existing) throw new Error(`Message ${messageId} not found`);
    existing.metadata = metadata === null ? null : { ...(existing.metadata ?? {}), ...metadata };
    return existing;
  }

  async deleteMessagesFrom(sessionId: string, fromMessageId: string): Promise<{ deletedIds: string[]; retained: ChatMessage[] }> {
    const inSession = this.messages.filter((message) => message.sessionId === sessionId);
    const targetIndex = inSession.findIndex((message) => message.id === fromMessageId);
    if (targetIndex === -1) return { deletedIds: [], retained: inSession };
    const retained = inSession.slice(0, targetIndex);
    const deletedIds = inSession.slice(targetIndex).map((message) => message.id);
    this.messages = this.messages.filter((message) => !deletedIds.includes(message.id));
    return { deletedIds, retained };
  }

  async recordTokenUsage(): Promise<void> { /* not exercised */ }
}

function captureSessionEvents(sessionId: string): { events: ChatStreamEvent[]; stop: () => void } {
  const events: ChatStreamEvent[] = [];
  const unsubscribe = chatStreamManager.subscribe(sessionId, (event) => { events.push(event); });
  return { events, stop: unsubscribe };
}

function stubAgentSession(replyText: string): void {
  __setCreateResolvedAgentSession(async (options: any) => ({
    session: {
      prompt: vi.fn().mockImplementation(async () => {
        options.onText?.(replyText);
      }),
      dispose: vi.fn(),
      state: { messages: [] },
    },
  }) as any);
}

describe("ChatManager.sendMessage — in-band user_message identity event (FN-459)", () => {
  let tmpDir: string;
  let chatStore: FakeChatStore;
  let chatManager: ChatManager;

  beforeEach(() => {
    __resetChatState();
    tmpDir = mkdtempSync(join(tmpdir(), "fn-459-user-message-"));
    chatStore = new FakeChatStore();
    chatManager = new ChatManager(chatStore as any, tmpDir);
  });

  afterEach(async () => {
    __resetChatState();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("broadcasts the persisted user row on an ordinary send, before done", async () => {
    const session = chatStore.createSession();
    stubAgentSession("hello back");
    const captured = captureSessionEvents(session.id);

    await chatManager.sendMessage(session.id, "bonjour");
    captured.stop();

    const userEventIndex = captured.events.findIndex((event) => event.type === "user_message");
    expect(userEventIndex).toBeGreaterThanOrEqual(0);
    const userEvent = captured.events[userEventIndex] as Extract<ChatStreamEvent, { type: "user_message" }>;
    const persistedUserRow = chatStore.messages.find((message) => message.role === "user");
    expect(persistedUserRow).toBeDefined();
    expect(userEvent.data.message.id).toBe(persistedUserRow!.id);
    expect(userEvent.data.message.id).toMatch(/^msg-/);
    expect(userEvent.data.message.id).not.toMatch(/^temp-/);
    expect(userEvent.data.message.role).toBe("user");
    expect(userEvent.data.message.content).toBe("bonjour");
    expect(userEvent.data.message.sessionId).toBe(session.id);

    const doneIndex = captured.events.findIndex((event) => event.type === "done");
    expect(doneIndex).toBeGreaterThan(userEventIndex);
  });

  it("broadcasts the persisted user row for a prepared replacement turn too", async () => {
    const session = chatStore.createSession();
    stubAgentSession("first reply");
    await chatManager.sendMessage(session.id, "bonjour");

    const originalUserRow = chatStore.messages.find((message) => message.role === "user")!;
    const prepared = await chatManager.prepareReplacement(session.id, originalUserRow.id);

    stubAgentSession("corrected reply");
    const captured = captureSessionEvents(session.id);
    await chatManager.sendMessage(session.id, "bonjour corrigé", undefined, undefined, undefined, { generationId: prepared.generationId });
    captured.stop();

    const userEvents = captured.events.filter((event) => event.type === "user_message") as Array<Extract<ChatStreamEvent, { type: "user_message" }>>;
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]!.data.message.content).toBe("bonjour corrigé");
    expect(userEvents[0]!.data.message.id).toMatch(/^msg-/);
    expect(chatStore.messages.some((message) => message.id === userEvents[0]!.data.message.id)).toBe(true);
  });

  it("broadcasts the persisted user row before the mentions dispatch early return", async () => {
    const agent = { id: "agent-mentioned", name: "helper", role: "custom" } as any;
    const agentStore = {
      init: vi.fn().mockResolvedValue(undefined),
      listAgents: vi.fn().mockResolvedValue([agent]),
      getAgent: vi.fn().mockResolvedValue(agent),
    };
    chatManager = new ChatManager(chatStore as any, tmpDir, agentStore as any);
    const session = chatStore.createSession();
    // The mentioned-agent reply generation is irrelevant here: the assertion is that the
    // identity event is emitted BEFORE `dispatchMentionedAgentReplies` returns early.
    stubAgentSession("mention reply");
    const captured = captureSessionEvents(session.id);

    await chatManager.sendMessage(session.id, "@helper regarde ça");
    captured.stop();

    const userEventIndex = captured.events.findIndex((event) => event.type === "user_message");
    expect(userEventIndex).toBeGreaterThanOrEqual(0);
    const userEvent = captured.events[userEventIndex] as Extract<ChatStreamEvent, { type: "user_message" }>;
    expect(userEvent.data.message.content).toBe("@helper regarde ça");
    expect(userEvent.data.message.id).toMatch(/^msg-/);

    // Proof the mentions branch (the early `return` right after persistence) was actually taken:
    // the persisted user row carries the parsed mention metadata, and the model-loop path that
    // would otherwise persist an assistant reply never ran.
    const persistedUserRow = chatStore.messages.find((message) => message.role === "user")!;
    expect(persistedUserRow.metadata).toMatchObject({ mentions: [{ agentId: "agent-mentioned", agentName: "helper" }] });
    expect(userEvent.data.message.id).toBe(persistedUserRow.id);

    // The identity event still precedes the mentions path's own terminal event.
    const terminalIndex = captured.events.findIndex((event) => event.type === "done" || event.type === "error");
    expect(terminalIndex).toBeGreaterThan(userEventIndex);
  });

  it("a throwing broadcast sink never fails the send nor loses the persisted user row", async () => {
    const session = chatStore.createSession();
    stubAgentSession("hello back");
    const hostile = chatStreamManager.subscribe(session.id, (event) => {
      if (event.type === "user_message") throw new Error("hostile sink");
    });

    await expect(chatManager.sendMessage(session.id, "bonjour")).resolves.toBeUndefined();
    hostile();

    const userRows = chatStore.messages.filter((message) => message.role === "user");
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.content).toBe("bonjour");
    // The turn still completed: the assistant reply persisted normally.
    expect(chatStore.messages.some((message) => message.role === "assistant")).toBe(true);
  });

  it("keeps the server-side 404 guard for an unknown (never persisted) message id", async () => {
    const session = chatStore.createSession();
    await expect(chatManager.prepareReplacement(session.id, "temp-123")).rejects.toMatchObject({
      message: `Message temp-123 not found in session ${session.id}`,
      statusCode: 404,
    });
  });
});

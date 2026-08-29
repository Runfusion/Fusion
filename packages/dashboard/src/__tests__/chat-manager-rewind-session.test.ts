/*
FNXC:ChatMessageEdit 2026-07-07-09:00:
"Forget everything after" seam test for FN-7628. Deleting `chat_messages` rows alone does NOT
make the model forget a discarded turn — the pi SessionManager file is a separate append-only
transcript that the model-loop path resumes from (see chat.ts `resolveCliSessionManager`). This
test proves the rewind at the seam that actually matters: after
`ChatManager.rewindSessionForEdit`, re-opening the SAME on-disk pi session file and calling
`buildSessionContext()` no longer includes the discarded turn's content, while the retained
turn's content survives. It deliberately does NOT mock `@earendil-works/pi-coding-agent` — a
real, temp-directory-backed `SessionManager` is used so the assertion exercises the actual
`branch()`/`resetLeaf()` behavior described in `session-manager.d.ts`, not a stub.

FNXC:ChatMessageEdit 2026-07-07-14:00:
Ported from upstream's sqlite-backed version: the sqlite ChatStore path is removed on this
branch (Database.init throws — SqliteFinalRemoval), so the chat_messages persistence side uses
an in-memory FakeChatStore implementing the async ChatStore surface ChatManager touches
(getSession/getMessage/deleteMessagesFrom/updateMessageMetadata/setCliSessionFile). The store
truncation semantics themselves are covered against real PostgreSQL in
packages/core/src/__tests__/postgres/chat-store-content-search-edit.pg.test.ts; the seam under
test here is the pi session branch/repoint behavior, which is store-agnostic.
*/
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  ChatManager,
  __resetChatState,
  __setCreateResolvedAgentSession,
} from "../chat.js";
import type { ChatMessage, ChatSession } from "@fusion/core";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function makeAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "chat",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function extractText(context: ReturnType<SessionManager["buildSessionContext"]>): string[] {
  return context.messages.flatMap((message: any) => {
    if (typeof message.content === "string") return [message.content];
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text as string);
    }
    return [];
  });
}

/**
 * Minimal in-memory stand-in for the async ChatStore surface exercised by
 * ChatManager.rewindSessionForEdit. Messages keep insertion order, matching the
 * (createdAt, insertion-order) contract of the real backends.
 */
class FakeChatStore {
  private sessions = new Map<string, ChatSession>();
  private messages: ChatMessage[] = [];
  private counter = 0;

  createSession(input: { agentId: string }): ChatSession {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: `chat-${++this.counter}`,
      agentId: input.agentId,
      title: null,
      status: "active",
      projectId: null,
      modelProvider: null,
      modelId: null,
      cliSessionFile: null,
      cliExecutorAdapterId: null,
      inFlightGeneration: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async setInFlightGeneration(_sessionId: string, _snapshot: unknown): Promise<void> {
    // In-flight generation persistence is irrelevant to the rewind seam under test.
  }

  async getSession(id: string): Promise<ChatSession | undefined> {
    return this.sessions.get(id);
  }

  async addMessage(
    sessionId: string,
    input: {
      role: "user" | "assistant";
      content: string;
      thinkingOutput?: string;
      metadata?: Record<string, unknown>;
    },
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
    return this.messages.find((m) => m.id === id);
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.messages.filter((m) => m.sessionId === sessionId);
  }

  async updateMessageMetadata(
    messageId: string,
    metadata: Record<string, unknown> | null,
    options?: { merge?: boolean },
  ): Promise<ChatMessage> {
    const existing = this.messages.find((m) => m.id === messageId);
    if (!existing) throw new Error(`Message ${messageId} not found`);
    const merge = options?.merge !== false;
    existing.metadata = metadata === null
      ? (merge ? existing.metadata : null)
      : (merge ? { ...(existing.metadata ?? {}), ...metadata } : metadata);
    return existing;
  }

  async deleteMessagesFrom(sessionId: string, fromMessageId: string): Promise<{ deletedIds: string[]; retained: ChatMessage[] }> {
    const inSession = this.messages.filter((m) => m.sessionId === sessionId);
    const targetIndex = inSession.findIndex((m) => m.id === fromMessageId);
    const target = this.messages.find((m) => m.id === fromMessageId);
    if (!target || target.sessionId !== sessionId || targetIndex === -1) {
      return { deletedIds: [], retained: inSession };
    }
    const retained = inSession.slice(0, targetIndex);
    const deletedIds = inSession.slice(targetIndex).map((m) => m.id);
    this.messages = this.messages.filter((m) => !deletedIds.includes(m.id));
    return { deletedIds, retained };
  }

  async setCliSessionFile(id: string, cliSessionFile: string | null): Promise<void> {
    const session = this.sessions.get(id);
    if (session) session.cliSessionFile = cliSessionFile;
  }
}

describe("ChatManager.rewindSessionForEdit — pi session context seam (real SessionManager)", () => {
  let tmpDir: string;
  let chatStore: FakeChatStore;
  let chatManager: ChatManager;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fn-chat-rewind-test-"));
    chatStore = new FakeChatStore();
    chatManager = new ChatManager(chatStore as any, tmpDir);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("primary path (recorded parent-leaf id): branch() forgets the edited turn and everything after it", async () => {
    const session = chatStore.createSession({ agentId: "agent-001" });

    // Seed a real, file-backed pi session with two user/assistant turn pairs, mirroring what
    // ChatManager.sendMessage would have produced across two prior chat turns.
    const seedManager = SessionManager.create(tmpDir);
    const sessionFile = seedManager.getSessionFile();
    expect(sessionFile).toBeTruthy();
    await chatStore.setCliSessionFile(session.id, sessionFile!);

    seedManager.appendMessage({ role: "user", content: "first turn", timestamp: Date.now() });
    seedManager.appendMessage(makeAssistantMessage("first reply"));
    const leafAfterTurn1 = seedManager.getLeafId();

    seedManager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });
    seedManager.appendMessage(makeAssistantMessage("second reply"));

    // Persist the corresponding chat_messages rows, recording the second user turn's pi
    // parent-leaf id the way ChatManager.sendMessage does before calling prompt().
    const m1 = await chatStore.addMessage(session.id, { role: "user", content: "first turn" });
    await chatStore.addMessage(session.id, { role: "assistant", content: "first reply" });
    const m3 = await chatStore.addMessage(session.id, { role: "user", content: "second turn" });
    await chatStore.updateMessageMetadata(m3.id, { piParentLeafId: leafAfterTurn1 });
    await chatStore.addMessage(session.id, { role: "assistant", content: "second reply" });

    // Sanity: before the edit, the full pi context includes both turns.
    const beforeTexts = extractText(seedManager.buildSessionContext());
    expect(beforeTexts).toContain("first turn");
    expect(beforeTexts).toContain("second turn");
    expect(beforeTexts).toContain("second reply");

    const { retained } = await chatManager.rewindSessionForEdit(session.id, m3.id);
    expect(retained.map((m) => m.id)).toEqual([m1.id, expect.any(String)]);
    expect(retained.map((m) => m.content)).toEqual(["first turn", "first reply"]);

    // The DB truncation alone is not the seam that matters — assert the persisted rows too,
    // but the load-bearing assertion is the pi session context below.
    expect((await chatStore.getMessages(session.id)).map((m) => m.content)).toEqual(["first turn", "first reply"]);

    // The rewind materializes a NEW session file (createBranchedSession) and repoints the
    // chat row at it — branch()/resetLeaf() alone only mutate an in-memory leaf pointer and do
    // not survive a fresh SessionManager.open() on the next turn, so re-fetch the file the next
    // real send would actually resume from and prove the discarded turn is unreachable there.
    const rewoundSession = (await chatStore.getSession(session.id))!;
    expect(rewoundSession.cliSessionFile).not.toBe(sessionFile);
    const reopened = SessionManager.open(rewoundSession.cliSessionFile!);
    const afterTexts = extractText(reopened.buildSessionContext());
    expect(afterTexts).toContain("first turn");
    expect(afterTexts).toContain("first reply");
    expect(afterTexts).not.toContain("second turn");
    expect(afterTexts).not.toContain("second reply");

    // The next real prompt resumes this retained branch, not the abandoned leaf.
    reopened.appendMessage({ role: "user", content: "corrected turn", timestamp: Date.now() });
    expect(extractText(reopened.buildSessionContext())).toContain("corrected turn");

    // The OLD file is never mutated (append-only tree semantics) — the discarded turn is still
    // physically present there, which is why repointing cliSessionFile (not just moving an
    // in-memory leaf) is the part of this fix that actually matters.
    const oldFileStillHasDiscardedTurn = extractText(SessionManager.open(sessionFile!).buildSessionContext());
    expect(oldFileStillHasDiscardedTurn).toContain("second turn");
  });

  it("persists an interrupted prefix into the reopened pi context exactly once", async () => {
    __resetChatState();
    const session = chatStore.createSession({ agentId: "agent-001" });
    session.title = "Existing title";
    const seedManager = SessionManager.create(tmpDir);
    await chatStore.setCliSessionFile(session.id, seedManager.getSessionFile()!);

    const prefix = "Distinct interrupted prefix";
    let rejectPrompt: ((reason?: unknown) => void) | undefined;
    __setCreateResolvedAgentSession(async (options: any) => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          options.onThinking?.("thinking prefix");
          options.onText?.(prefix);
          return new Promise<void>((_resolve, reject) => {
            rejectPrompt = reject;
          });
        }),
        dispose: vi.fn().mockImplementation(() => rejectPrompt?.(new Error("disposed"))),
        state: { messages: [] },
      },
    }) as any);

    const sendPromise = chatManager.sendMessage(session.id, "hello");
    await new Promise((resolve) => setImmediate(resolve));
    const cancellation = await chatManager.cancelGeneration(session.id);
    await sendPromise;

    expect(cancellation).toEqual(expect.objectContaining({ success: true, interrupted: true }));
    const assistantRows = (await chatStore.getMessages(session.id)).filter((message) => message.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toEqual(expect.objectContaining({
      content: prefix,
      metadata: expect.objectContaining({ interrupted: true }),
    }));

    const reopened = SessionManager.open((await chatStore.getSession(session.id))!.cliSessionFile!);
    const contextTexts = extractText(reopened.buildSessionContext());
    expect(contextTexts.filter((text) => text === prefix)).toHaveLength(1);

    __resetChatState();
  });

  it("falls back to a rebuilt retained session when branch materialization fails", async () => {
    const session = chatStore.createSession({ agentId: "agent-001" });
    const seedManager = SessionManager.create(tmpDir);
    const sessionFile = seedManager.getSessionFile()!;
    await chatStore.setCliSessionFile(session.id, sessionFile);
    seedManager.appendMessage({ role: "user", content: "kept turn", timestamp: Date.now() });
    seedManager.appendMessage(makeAssistantMessage("kept reply"));
    seedManager.appendMessage({ role: "user", content: "discarded turn", timestamp: Date.now() });
    seedManager.appendMessage(makeAssistantMessage("discarded reply"));

    await chatStore.addMessage(session.id, { role: "user", content: "kept turn" });
    await chatStore.addMessage(session.id, { role: "assistant", content: "kept reply" });
    const target = await chatStore.addMessage(session.id, { role: "user", content: "discarded turn" });
    await chatStore.updateMessageMetadata(target.id, { piParentLeafId: "missing-leaf" });
    await chatStore.addMessage(session.id, { role: "assistant", content: "discarded reply" });

    const { retained } = await chatManager.rewindSessionForEdit(session.id, target.id);
    expect(retained.map((item) => item.content)).toEqual(["kept turn", "kept reply"]);
    const rebuiltSession = (await chatStore.getSession(session.id))!;
    expect(rebuiltSession.cliSessionFile).not.toBe(sessionFile);
    const rebuilt = SessionManager.open(rebuiltSession.cliSessionFile!);
    const rebuiltTexts = extractText(rebuilt.buildSessionContext());
    expect(rebuiltTexts).toContain("kept turn");
    expect(rebuiltTexts).toContain("kept reply");
    expect(rebuiltTexts).not.toContain("discarded turn");
    expect(rebuiltTexts).not.toContain("discarded reply");
  });

  it("prepares one replacement generation and fences duplicate/ordinary sends", async () => {
    const session = chatStore.createSession({ agentId: "agent-001" });
    const seedManager = SessionManager.create(tmpDir);
    await chatStore.setCliSessionFile(session.id, seedManager.getSessionFile()!);
    const target = await chatStore.addMessage(session.id, { role: "user", content: "replace me" });

    const preparation = chatManager.prepareReplacement(session.id, target.id);
    expect(() => chatManager.beginGeneration(session.id)).toThrow(/already being prepared/);
    await expect(chatManager.prepareReplacement(session.id, target.id)).rejects.toThrow(/already being prepared/);

    const prepared = await preparation;
    expect(prepared.generationId).toBe(chatManager.getActiveGenerationId(session.id));
    expect(prepared.retained).toEqual([]);
    chatManager.releasePreparedReplacement(session.id, prepared.generationId);
    expect(chatManager.isGenerating(session.id)).toBe(false);
  });

  it("primary path, first-turn edit (no recorded parent leaf): resetLeaf() forgets everything", async () => {
    const session = chatStore.createSession({ agentId: "agent-001" });

    const seedManager = SessionManager.create(tmpDir);
    const sessionFile = seedManager.getSessionFile();
    await chatStore.setCliSessionFile(session.id, sessionFile!);

    // First turn: parent leaf is null (nothing before it).
    seedManager.appendMessage({ role: "user", content: "only turn", timestamp: Date.now() });
    seedManager.appendMessage(makeAssistantMessage("only reply"));

    const m1 = await chatStore.addMessage(session.id, { role: "user", content: "only turn" });
    await chatStore.updateMessageMetadata(m1.id, { piParentLeafId: null });
    await chatStore.addMessage(session.id, { role: "assistant", content: "only reply" });

    const { retained } = await chatManager.rewindSessionForEdit(session.id, m1.id);
    expect(retained).toEqual([]);

    const rewoundSession = (await chatStore.getSession(session.id))!;
    expect(rewoundSession.cliSessionFile).not.toBe(sessionFile);
    const reopened = SessionManager.open(rewoundSession.cliSessionFile!);
    const afterTexts = extractText(reopened.buildSessionContext());
    expect(afterTexts).not.toContain("only turn");
    expect(afterTexts).not.toContain("only reply");
  });

  it("rejects editing a non-user message", async () => {
    const session = chatStore.createSession({ agentId: "agent-001" });
    const seedManager = SessionManager.create(tmpDir);
    await chatStore.setCliSessionFile(session.id, seedManager.getSessionFile()!);
    const assistantMsg = await chatStore.addMessage(session.id, { role: "assistant", content: "hi" });

    await expect(chatManager.rewindSessionForEdit(session.id, assistantMsg.id)).rejects.toThrow(/user message/);
  });

  it("rejects an edit while a generation is in flight for the session", async () => {
    const session = chatStore.createSession({ agentId: "agent-001" });
    const seedManager = SessionManager.create(tmpDir);
    await chatStore.setCliSessionFile(session.id, seedManager.getSessionFile()!);
    const userMsg = await chatStore.addMessage(session.id, { role: "user", content: "hi" });

    chatManager.beginGeneration(session.id);
    try {
      await expect(chatManager.rewindSessionForEdit(session.id, userMsg.id)).rejects.toThrow(/generation is currently in progress/);
    } finally {
      chatManager.cancelGeneration(session.id);
    }
  });
});

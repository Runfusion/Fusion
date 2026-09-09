import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession, ChatStore } from "@fusion/core";
import {
  CONVERSATION_MESSAGE_MAX_CHARS,
  CONVERSATION_READ_DEFAULT_LIMIT,
  CONVERSATION_READ_MAX_LIMIT,
  CONVERSATION_SEARCH_EXCERPT_CHARS,
  CONVERSATION_SEARCH_MAX_MATCHES,
  CONVERSATION_SEARCH_SCAN_LIMIT,
  CONVERSATION_TOOL_RESPONSE_MAX_CHARS,
  buildConversationReferenceContext,
  createChatConversationTools,
  parseConversationReferences,
} from "../chat-conversation-references.js";

const PROJECT_ID = "project-a";
const CURRENT_SESSION_ID = "chat-00000000";
const REFERENCED_SESSION_ID = "chat-1a2b3c4d";
const CROSS_PROJECT_SESSION_ID = "chat-deadbeef";

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: REFERENCED_SESSION_ID,
    agentId: "agent-1",
    tags: [],
    title: "Delivery status",
    status: "active",
    projectId: PROJECT_ID,
    modelProvider: "anthropic",
    modelId: "claude-sonnet-4-5",
    thinkingLevel: null,
    memoryFocus: null,
    createdAt: "2026-09-04T08:00:00.000Z",
    updatedAt: "2026-09-04T09:00:00.000Z",
    pinnedAt: null,
    cliSessionFile: null,
    inFlightGeneration: null,
    cliExecutorAdapterId: null,
    ...overrides,
  };
}

function message(index: number, content = `message ${index}`, role: ChatMessage["role"] = "user"): ChatMessage {
  return {
    id: `msg-${index}`,
    sessionId: REFERENCED_SESSION_ID,
    role,
    content,
    thinkingOutput: null,
    metadata: null,
    createdAt: `2026-09-04T08:${String(index).padStart(2, "0")}:00.000Z`,
  };
}

function makeStore(options: {
  sessions?: ChatSession[];
  messages?: ChatMessage[];
  getMessages?: ChatStore["getMessages"];
} = {}) {
  const sessions = options.sessions ?? [session()];
  const messages = options.messages ?? [];
  const getSession = vi.fn(async (id: string) => sessions.find((candidate) => candidate.id === id));
  const getMessages = options.getMessages
    ? vi.fn(options.getMessages)
    : vi.fn(async (_id: string, filter?: { limit?: number; offset?: number; order?: "asc" | "desc" }) => {
        const ordered = [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        if (filter?.order === "desc") ordered.reverse();
        const offset = filter?.offset ?? 0;
        return ordered.slice(offset, offset + (filter?.limit ?? ordered.length));
      });
  return {
    store: { getSession, getMessages } as unknown as ChatStore,
    getSession,
    getMessages,
  };
}

function resultText(result: unknown): string {
  return ((result as { content: Array<{ type: string; text: string }> }).content[0]?.text) ?? "";
}

async function executeTool(store: ChatStore, name: string, params: Record<string, unknown>) {
  const tool = createChatConversationTools(store, {
    currentSessionId: CURRENT_SESSION_ID,
    projectId: PROJECT_ID,
  }).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return (tool.execute as any)("tool-call", params, undefined, undefined, {});
}

describe("parseConversationReferences", () => {
  it("returns no references when no conversation token exists", () => {
    expect(parseConversationReferences("Inspect #FN-292 and #src/chat.ts")).toEqual([]);
  });

  it("detects references after start, whitespace, or punctuation", () => {
    expect(parseConversationReferences("#chat-1a2b3c4d, compare (#chat-deadbeef)."))
      .toEqual(["chat-1a2b3c4d", "chat-deadbeef"]);
  });

  it("deduplicates in first-seen order and caps references at three", () => {
    expect(parseConversationReferences(
      "#chat-11111111 #chat-22222222 #chat-11111111 #chat-33333333 #chat-44444444",
    )).toEqual(["chat-11111111", "chat-22222222", "chat-33333333"]);
  });

  it("ignores file-like suffixes and tokens attached to a preceding word", () => {
    expect(parseConversationReferences(
      "Open #chat-notes.md and ignore prefix#chat-1a2b3c4d or #chat-1a2b3c4d-more",
    )).toEqual([]);
  });
});

describe("buildConversationReferenceContext", () => {
  it("returns an empty block without reading the store when no reference exists", async () => {
    const { store, getSession, getMessages } = makeStore();

    await expect(buildConversationReferenceContext({
      chatStore: store,
      content: "How is delivery progressing?",
      currentSessionId: CURRENT_SESSION_ID,
      currentProjectId: PROJECT_ID,
    })).resolves.toBe("");
    expect(getSession).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("renders bounded metadata and the five latest messages", async () => {
    const longMessage = `latest ${"x".repeat(500)}`;
    const messages = [
      message(0),
      message(1),
      message(2),
      message(3),
      message(4),
      message(5, longMessage, "assistant"),
    ];
    const { store, getMessages } = makeStore({ messages });

    const context = await buildConversationReferenceContext({
      chatStore: store,
      content: `How is #${REFERENCED_SESSION_ID}?`,
      currentSessionId: CURRENT_SESSION_ID,
      currentProjectId: PROJECT_ID,
    });

    expect(getMessages).toHaveBeenCalledWith(REFERENCED_SESSION_ID, { limit: 5, order: "desc" });
    expect(context).toContain(`[Referenced Conversation: ${REFERENCED_SESSION_ID}]`);
    expect(context).toContain("Title: Delivery status");
    expect(context).toContain("Status: active");
    expect(context).toContain("Agent: agent-1");
    expect(context).toContain("Model: anthropic/claude-sonnet-4-5");
    expect(context).toContain("message 1");
    expect(context).not.toContain("message 0");
    expect(context).not.toContain(longMessage);
    expect(context).toContain("fn_chat_conversation_read");
    expect(context).toContain(`[/Referenced Conversation: ${REFERENCED_SESSION_ID}]`);
  });

  it("marks an existing conversation with no messages", async () => {
    const { store } = makeStore();
    const context = await buildConversationReferenceContext({
      chatStore: store,
      content: `Inspect #${REFERENCED_SESSION_ID}`,
      currentSessionId: CURRENT_SESSION_ID,
      currentProjectId: PROJECT_ID,
    });
    expect(context).toContain("(no messages)");
  });

  it("treats a cross-project conversation exactly like an unknown ID", async () => {
    const crossProject = session({ id: CROSS_PROJECT_SESSION_ID, projectId: "project-b", title: "Secret title" });
    const crossStore = makeStore({ sessions: [crossProject] }).store;
    const unknownStore = makeStore({ sessions: [] }).store;
    const input = {
      content: `Inspect #${CROSS_PROJECT_SESSION_ID}`,
      currentSessionId: CURRENT_SESSION_ID,
      currentProjectId: PROJECT_ID,
    };

    const crossProjectContext = await buildConversationReferenceContext({ ...input, chatStore: crossStore });
    const unknownContext = await buildConversationReferenceContext({ ...input, chatStore: unknownStore });

    expect(crossProjectContext).toBe(unknownContext);
    expect(crossProjectContext).toContain("Unavailable: no conversation with this ID exists in this project.");
    expect(crossProjectContext).not.toContain("Secret title");
  });

  it("marks a self-reference without previewing messages", async () => {
    const current = session({ id: CURRENT_SESSION_ID });
    const { store, getMessages } = makeStore({ sessions: [current], messages: [message(1, "private")] });
    const context = await buildConversationReferenceContext({
      chatStore: store,
      content: `Summarize #${CURRENT_SESSION_ID}`,
      currentSessionId: CURRENT_SESSION_ID,
      currentProjectId: PROJECT_ID,
    });

    expect(context).toContain("Current conversation");
    expect(context).not.toContain("private");
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("degrades message read failures to the same unavailable block", async () => {
    const failingStore = makeStore({
      getMessages: async () => { throw new Error("database unavailable"); },
    }).store;
    const unknownStore = makeStore({ sessions: [] }).store;
    const input = {
      content: `Inspect #${REFERENCED_SESSION_ID}`,
      currentSessionId: CURRENT_SESSION_ID,
      currentProjectId: PROJECT_ID,
    };

    await expect(buildConversationReferenceContext({ ...input, chatStore: failingStore }))
      .resolves.toBe(await buildConversationReferenceContext({ ...input, chatStore: unknownStore }));
  });
});

describe("fn_chat_conversation_read", () => {
  it("reads newest messages first with the default page", async () => {
    const { store, getMessages } = makeStore({ messages: [message(1), message(2)] });
    const result = await executeTool(store, "fn_chat_conversation_read", {
      conversation_id: REFERENCED_SESSION_ID,
    });

    expect(getMessages).toHaveBeenCalledWith(REFERENCED_SESSION_ID, {
      limit: CONVERSATION_READ_DEFAULT_LIMIT,
      offset: 0,
      order: "desc",
    });
    expect(resultText(result).indexOf("message 2")).toBeLessThan(resultText(result).indexOf("message 1"));
  });

  it("caps the limit, respects offset, and supports ascending order", async () => {
    const { store, getMessages } = makeStore({ messages: [message(1), message(2), message(3)] });
    const result = await executeTool(store, "fn_chat_conversation_read", {
      conversation_id: REFERENCED_SESSION_ID,
      limit: 999,
      offset: 2,
      order: "asc",
    });

    expect(getMessages).toHaveBeenCalledWith(REFERENCED_SESSION_ID, {
      limit: CONVERSATION_READ_MAX_LIMIT,
      offset: 2,
      order: "asc",
    });
    expect(resultText(result)).toContain("message 3");
    expect(resultText(result)).not.toContain("message 1");
  });

  it("truncates individual messages and gives a narrowing hint", async () => {
    const content = "x".repeat(CONVERSATION_MESSAGE_MAX_CHARS + 200);
    const { store } = makeStore({ messages: [message(1, content)] });
    const result = await executeTool(store, "fn_chat_conversation_read", {
      conversation_id: REFERENCED_SESSION_ID,
    });
    const text = resultText(result);

    expect(text).not.toContain(content);
    expect(text).toContain("Some messages were truncated");
  });

  it("bounds the complete response and preserves a global narrowing hint", async () => {
    const messages = Array.from({ length: 100 }, (_, index) => message(index, `${index}:${"x".repeat(2_000)}`));
    const { store } = makeStore({ messages });
    const result = await executeTool(store, "fn_chat_conversation_read", {
      conversation_id: REFERENCED_SESSION_ID,
      limit: 100,
    });
    const text = resultText(result);

    expect(text.length).toBeLessThanOrEqual(CONVERSATION_TOOL_RESPONSE_MAX_CHARS);
    expect(text).toContain("Output truncated. Retry with a smaller limit or a larger offset.");
  });

  it("returns the same non-disclosing error for unknown and cross-project IDs", async () => {
    const cross = session({ id: CROSS_PROJECT_SESSION_ID, projectId: "project-b", title: "Secret title" });
    const crossResult = await executeTool(
      makeStore({ sessions: [cross] }).store,
      "fn_chat_conversation_read",
      { conversation_id: CROSS_PROJECT_SESSION_ID },
    );
    const unknownResult = await executeTool(
      makeStore({ sessions: [] }).store,
      "fn_chat_conversation_read",
      { conversation_id: CROSS_PROJECT_SESSION_ID },
    );

    expect(resultText(crossResult)).toBe(resultText(unknownResult));
    expect(crossResult).toMatchObject({ isError: true });
    expect(resultText(crossResult)).not.toContain("Secret title");
  });
});

describe("fn_chat_conversation_search", () => {
  it("matches literally without case sensitivity and returns a bounded excerpt", async () => {
    const content = `${"a".repeat(300)}NeedLE literal.${"b".repeat(300)}`;
    const { store } = makeStore({ messages: [message(1, content, "assistant")] });
    const result = await executeTool(store, "fn_chat_conversation_search", {
      conversation_id: REFERENCED_SESSION_ID,
      query: "needle literal.",
    });
    const matchLine = resultText(result).split("\n").find((line) => line.startsWith("[assistant @"));
    const excerpt = matchLine?.slice(matchLine.indexOf("] ") + 2) ?? "";

    expect(excerpt.toLocaleLowerCase()).toContain("needle literal.");
    expect(excerpt.length).toBeLessThanOrEqual(CONVERSATION_SEARCH_EXCERPT_CHARS);
  });

  it("caps matches at twenty-five", async () => {
    const messages = Array.from({ length: 30 }, (_, index) => message(index, `match ${index}`));
    const { store } = makeStore({ messages });
    const result = await executeTool(store, "fn_chat_conversation_search", {
      conversation_id: REFERENCED_SESSION_ID,
      query: "MATCH",
      limit: 999,
    }) as { details: { matchCount: number; limit: number } };

    expect(result.details.matchCount).toBe(CONVERSATION_SEARCH_MAX_MATCHES);
    expect(result.details.limit).toBe(CONVERSATION_SEARCH_MAX_MATCHES);
  });

  it("signals when the recent-message scan window is saturated", async () => {
    const messages = Array.from(
      { length: CONVERSATION_SEARCH_SCAN_LIMIT },
      (_, index) => message(index, `message ${index}`),
    );
    const { store, getMessages } = makeStore({ messages });
    const result = await executeTool(store, "fn_chat_conversation_search", {
      conversation_id: REFERENCED_SESSION_ID,
      query: "absent",
    });

    expect(getMessages).toHaveBeenCalledWith(REFERENCED_SESSION_ID, {
      limit: CONVERSATION_SEARCH_SCAN_LIMIT,
      order: "desc",
    });
    expect(resultText(result)).toContain(`Search window saturated at the ${CONVERSATION_SEARCH_SCAN_LIMIT} most recent messages`);
  });

  it("refuses an empty query", async () => {
    const result = await executeTool(makeStore().store, "fn_chat_conversation_search", {
      conversation_id: REFERENCED_SESSION_ID,
      query: "   ",
    });

    expect(result).toMatchObject({ isError: true });
    expect(resultText(result)).toBe("ERROR: query must be a non-empty string.");
  });

  it("returns the same non-disclosing error for unknown and cross-project IDs", async () => {
    const cross = session({ id: CROSS_PROJECT_SESSION_ID, projectId: "project-b", title: "Secret title" });
    const crossResult = await executeTool(
      makeStore({ sessions: [cross] }).store,
      "fn_chat_conversation_search",
      { conversation_id: CROSS_PROJECT_SESSION_ID, query: "secret" },
    );
    const unknownResult = await executeTool(
      makeStore({ sessions: [] }).store,
      "fn_chat_conversation_search",
      { conversation_id: CROSS_PROJECT_SESSION_ID, query: "secret" },
    );

    expect(resultText(crossResult)).toBe(resultText(unknownResult));
    expect(crossResult).toMatchObject({ isError: true });
    expect(resultText(crossResult)).not.toContain("Secret title");
  });
});

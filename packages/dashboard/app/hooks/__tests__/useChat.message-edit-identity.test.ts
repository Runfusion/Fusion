/*
FNXC:ChatMessageEdit 2026-09-16-05:58:
FN-459 Symptom Verification. Original symptom: editing a message the operator had JUST sent failed
with `Message temp-1789537275231 not found in session chat-87bb623c` and the typed correction was
lost. Root cause: the optimistic bubble kept its local `temp-<ts>` id because the only identity
repair channel was the out-of-band `chat:message:added` echo, matched by CONTENT equality.

These tests replay exactly that sequence and pin the fix: the in-band `user_message` stream event
retires the temp id by EXACT temp id, `editMessageAndResend` never posts a non-persisted id, and a
rejected edit republishes the correction instead of destroying it.

Lives in its own file because `useChat.test.ts` already exceeds the `check:line-count` baseline.
*/
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../useChat";
import { isPersistedChatMessageId } from "../chatTypes";
import * as apiModule from "../../api";
import type { ChatMessage, ChatSession } from "@fusion/core";

vi.mock("../../api", () => ({
  fetchChatSessions: vi.fn(),
  fetchChatTags: vi.fn().mockResolvedValue({ tags: [] }),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  streamChatResponse: vi.fn(),
  attachChatStream: vi.fn(),
  cancelChatResponse: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
  getPersistedChatOpenSession: vi.fn().mockReturnValue(null),
  setPersistedChatOpenSession: vi.fn(),
  clearPersistedChatOpenSession: vi.fn(),
}));

let sseHandlers: Record<string, ((event: MessageEvent) => void) | undefined> = {};
vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, options?: { events?: Record<string, (event: MessageEvent) => void> }) => {
    if (options?.events) sseHandlers = options.events;
    return () => {};
  }),
}));

const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockFetchChatSession = vi.mocked(apiModule.fetchChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);
const mockAttachChatStream = vi.mocked(apiModule.attachChatStream);
const mockCancelChatResponse = vi.mocked(apiModule.cancelChatResponse);

function makeSession(id: string): ChatSession {
  return {
    id,
    agentId: "agent-001",
    status: "active",
    title: "Session",
    projectId: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    pinnedAt: null,
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
  } as ChatSession;
}

function makeMessage(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "sessionId" | "role" | "content">): ChatMessage {
  return {
    thinkingOutput: null,
    metadata: null,
    createdAt: "2026-09-16T00:00:01.000Z",
    ...overrides,
  } as ChatMessage;
}

/** Handlers captured from the latest `streamChatResponse` call. */
type CapturedStream = {
  handlers: Record<string, ((payload: any) => void) | undefined>;
  options?: { replacementMessageId?: string };
};

const captured: CapturedStream[] = [];

/**
 * Mount the hook on one session. `seedMessages` is served by `fetchChatMessages`, which the hook
 * calls on selection — that is the only transcript-loading entry point exposed to callers.
 */
async function mountWithSession(seedMessages: ChatMessage[] = [], sessionId = "chat-87bb623c") {
  mockFetchChatSessions.mockResolvedValue({ sessions: [makeSession(sessionId)] });
  mockFetchChatMessages.mockResolvedValue({ messages: seedMessages });
  const hook = renderHook(() => useChat("proj-1"));
  await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
  act(() => { hook.result.current.selectSession(sessionId); });
  await waitFor(() => expect(hook.result.current.activeSession?.id).toBe(sessionId));
  if (seedMessages.length > 0) {
    await waitFor(() => expect(hook.result.current.messages).toHaveLength(seedMessages.length));
  }
  return hook;
}

describe("useChat — persisted chat message identity (FN-459)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    captured.length = 0;
    sseHandlers = {};
    mockFetchChatSessions.mockResolvedValue({ sessions: [] });
    mockFetchChatSession.mockImplementation(async (id: string) => ({ session: makeSession(id) }) as never);
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockCancelChatResponse.mockResolvedValue({ success: true });
    mockStreamChatResponse.mockImplementation(((_sessionId: string, _content: string, handlers: any, _attachments: unknown, _projectId: unknown, options: any) => {
      captured.push({ handlers, options });
      return { close: vi.fn(), isConnected: () => true };
    }) as unknown as typeof apiModule.streamChatResponse);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  /* Symptom Verification assertion (1): no `temp-` id survives the in-band identity event. */
  it("retires the optimistic temp id as soon as the in-band user_message arrives", async () => {
    const { result } = await mountWithSession();

    act(() => { result.current.sendMessage("bonjour"); });
    await waitFor(() => {
      expect(result.current.messages.filter((message) => message.role === "user")).toHaveLength(1);
    });
    expect(result.current.messages[0]?.id).toMatch(/^temp-/);

    const persisted = makeMessage({ id: "msg-ab12cd34", sessionId: "chat-87bb623c", role: "user", content: "bonjour" });
    act(() => {
      captured[0]?.handlers.onUserMessage?.({ message: persisted });
    });

    await waitFor(() => {
      expect(result.current.messages[0]?.id).toBe("msg-ab12cd34");
    });
    expect(result.current.messages.some((message) => message.id.startsWith("temp-"))).toBe(false);
  });

  it("gives two identical consecutive sends their own persisted ids (no content-equality collision)", async () => {
    const { result } = await mountWithSession();

    act(() => { result.current.sendMessage("même texte"); });
    await waitFor(() => expect(captured).toHaveLength(1));
    act(() => {
      captured[0]?.handlers.onUserMessage?.({
        message: makeMessage({ id: "msg-first001", sessionId: "chat-87bb623c", role: "user", content: "même texte" }),
      });
      captured[0]?.handlers.onDone?.({ messageId: "msg-reply1", accumulated: { text: "ok", thinking: "", toolCalls: [] } });
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));

    act(() => { result.current.sendMessage("même texte"); });
    await waitFor(() => expect(captured).toHaveLength(2));
    act(() => {
      captured[1]?.handlers.onUserMessage?.({
        message: makeMessage({
          id: "msg-second02",
          sessionId: "chat-87bb623c",
          role: "user",
          content: "même texte",
          createdAt: "2026-09-16T00:00:05.000Z",
        }),
      });
    });

    await waitFor(() => {
      const userIds = result.current.messages.filter((message) => message.role === "user").map((message) => message.id);
      expect(userIds).toEqual(["msg-first001", "msg-second02"]);
    });
    expect(result.current.messages.some((message) => message.id.startsWith("temp-"))).toBe(false);
  });

  /* Symptom Verification assertion (2): the edit always posts a persisted `msg-` id. */
  it("posts a persisted replacementMessageId after the in-band identity event", async () => {
    const { result } = await mountWithSession();

    act(() => { result.current.sendMessage("bonjour"); });
    await waitFor(() => expect(captured).toHaveLength(1));
    act(() => {
      captured[0]?.handlers.onUserMessage?.({
        message: makeMessage({ id: "msg-ab12cd34", sessionId: "chat-87bb623c", role: "user", content: "bonjour" }),
      });
      captured[0]?.handlers.onDone?.({ messageId: "msg-reply1", accumulated: { text: "ok", thinking: "", toolCalls: [] } });
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));

    const visibleId = result.current.messages[0]!.id;
    let editPromise!: Promise<void>;
    act(() => { editPromise = result.current.editMessageAndResend(visibleId, "bonjour corrigé"); });
    await waitFor(() => expect(captured).toHaveLength(2));
    act(() => { captured[1]?.handlers.onAccepted?.(undefined); });
    await act(async () => { await editPromise; });

    const replacementMessageId = captured[1]?.options?.replacementMessageId;
    expect(replacementMessageId).not.toMatch(/^temp-/);
    expect(replacementMessageId).toMatch(/^msg-/);
    expect(replacementMessageId).toBe("msg-ab12cd34");
  });

  /* The out-of-band echo remains the safety net for older servers / interrupted streams. */
  it("still reconciles through the chat:message:added echo when no user_message arrives", async () => {
    const { result } = await mountWithSession();

    act(() => { result.current.sendMessage("bonjour"); });
    await waitFor(() => expect(result.current.messages[0]?.id).toMatch(/^temp-/));

    act(() => {
      sseHandlers["chat:message:added"]?.({
        data: JSON.stringify(makeMessage({ id: "msg-echo0001", sessionId: "chat-87bb623c", role: "user", content: "bonjour" })),
      } as MessageEvent);
    });

    await waitFor(() => expect(result.current.messages[0]?.id).toBe("msg-echo0001"));
  });

  /* Symptom Verification assertion (3): a rejected edit republishes the correction. */
  it("republishes the typed correction when the edit is rejected", async () => {
    const persistedRow = makeMessage({ id: "msg-ab12cd34", sessionId: "chat-87bb623c", role: "user", content: "bonjour" });
    const { result } = await mountWithSession([persistedRow]);

    // The failure reload returns the row under a NEW id, which is what remounts the editor row.
    const reloadedRow = makeMessage({ id: "msg-reloaded1", sessionId: "chat-87bb623c", role: "user", content: "bonjour" });
    mockFetchChatMessages.mockResolvedValue({ messages: [reloadedRow] });

    let editPromise!: Promise<void>;
    act(() => { editPromise = result.current.editMessageAndResend("msg-ab12cd34", "bonjour corrigé"); });
    const rejection = editPromise.catch((error: unknown) => error);
    await waitFor(() => expect(captured).toHaveLength(1));
    // A pre-acceptance server rejection is the path that reloads authoritative rows and remounts
    // the editor row, destroying the inline editor's local state on `main`.
    act(() => {
      captured[0]?.handlers.onError?.("Request failed: 404", { requestAccepted: false, receivedStreamEvent: false });
    });

    await expect(rejection).resolves.toMatchObject({ message: "Failed to edit message" });
    await waitFor(() => {
      expect(result.current.editDraftRestore).toEqual({ messageId: "msg-reloaded1", content: "bonjour corrigé" });
    });

    act(() => { result.current.clearEditDraftRestore("msg-reloaded1"); });
    await waitFor(() => expect(result.current.editDraftRestore).toBeNull());
  });

  /* Symptom Verification assertion (4) is server-side and lives in chat-manager-user-message-event.test.ts. */
  it("refuses a non-persisted target locally instead of provoking the server 404", async () => {
    const { result } = await mountWithSession();

    act(() => { result.current.sendMessage("bonjour"); });
    await waitFor(() => expect(captured).toHaveLength(1));
    act(() => { captured[0]?.handlers.onDone?.({ messageId: "", accumulated: { text: "ok", thinking: "", toolCalls: [] } }); });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));

    const tempId = result.current.messages[0]!.id;
    expect(tempId).toMatch(/^temp-/);
    // Realignment fetch finds no persisted row at that position.
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    await expect(result.current.editMessageAndResend(tempId, "bonjour corrigé")).rejects.toThrow("Failed to edit message");
    // No replacement request was ever issued — the guaranteed 404 is unreachable from the UI.
    expect(captured.filter((entry) => entry.options?.replacementMessageId)).toHaveLength(0);
    await waitFor(() => {
      expect(result.current.editDraftRestore).toEqual({ messageId: tempId, content: "bonjour corrigé" });
    });
  });

  /* (g) A fully persisted transcript edits with NO realignment fetch and no added latency. */
  it("edits a server-loaded msg-<uuid8> transcript without any realignment fetch", async () => {
    const { result } = await mountWithSession([
      makeMessage({ id: "msg-ab12cd34", sessionId: "chat-87bb623c", role: "user", content: "bonjour" }),
    ]);

    const fetchCallsBeforeEdit = mockFetchChatMessages.mock.calls.length;
    let editPromise!: Promise<void>;
    act(() => { editPromise = result.current.editMessageAndResend("msg-ab12cd34", "bonjour corrigé"); });
    await waitFor(() => expect(captured).toHaveLength(1));
    act(() => { captured[0]?.handlers.onAccepted?.(undefined); });
    await act(async () => { await editPromise; });

    expect(mockFetchChatMessages.mock.calls.length).toBe(fetchCallsBeforeEdit);
    expect(captured[0]?.options?.replacementMessageId).toBe("msg-ab12cd34");
  });
});

/*
(f) Truth table for the shared identity helper. `msg-`/`rmsg-` MUST be persisted: classifying them
as local would disable editing for the entire loaded transcript and break the case above.
*/
describe("isPersistedChatMessageId truth table (FN-459)", () => {
  it.each([
    ["msg-ab12cd34", true],
    ["rmsg-ab12cd34", true],
    ["m1", true],
    ["1", true],
    ["temp-1789537275231", false],
    ["optimistic-1", false],
    ["error-1", false],
    ["interrupted-1", false],
    ["streaming-assistant", false],
    ["", false],
  ] as const)("classifies %s as persisted=%s", (id, expected) => {
    expect(isPersistedChatMessageId(id)).toBe(expected);
  });
});

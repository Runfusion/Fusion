import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@fusion/core";
import * as apiModule from "../../api";
import { getChatPendingMessageKey } from "../chatPendingMessageStorage";
import { getPersistedLastQuickChatSessionId } from "../quickChatLastSessionStorage";
import { FN_AGENT_ID, useQuickChat } from "../useQuickChat";

vi.mock("../../api", () => ({
  fetchResumeChatSession: vi.fn(),
  fetchChatSessions: vi.fn(),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  streamChatResponse: vi.fn(),
  attachChatStream: vi.fn(),
  cancelChatResponse: vi.fn(),
}));

const mockFetchResumeChatSession = vi.mocked(apiModule.fetchResumeChatSession);
const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockFetchChatSession = vi.mocked(apiModule.fetchChatSession);
const mockCreateChatSession = vi.mocked(apiModule.createChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);
const mockAttachChatStream = vi.mocked(apiModule.attachChatStream);
const mockCancelChatResponse = vi.mocked(apiModule.cancelChatResponse);

function makeSession(overrides: Partial<ChatSession> & Pick<ChatSession, "id" | "agentId">): ChatSession {
  return {
    id: overrides.id,
    agentId: overrides.agentId,
    title: overrides.title ?? null,
    status: overrides.status ?? "active",
    projectId: overrides.projectId ?? null,
    modelProvider: overrides.modelProvider ?? null,
    modelId: overrides.modelId ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

const setDocumentVisibilityState = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  fireEvent(document, new Event("visibilitychange"));
};

describe("useQuickChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchResumeChatSession.mockResolvedValue({ session: null });
    mockFetchChatSessions.mockResolvedValue({ sessions: [] });
    mockCreateChatSession.mockResolvedValue({
      session: makeSession({ id: "session-001", agentId: "agent-001" }),
    });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchChatSession.mockResolvedValue({
      session: { ...makeSession({ id: "session-001", agentId: "agent-001" }), isGenerating: false },
    });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockCancelChatResponse.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("queues first send made before session init completes and streams once ready", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    let onDone: ((data: { messageId: string }) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onDone = handlers.onDone as typeof onDone;
      return { close: vi.fn(), isConnected: () => true };
    });

    const initPromise = act(async () => {
      await result.current.switchSession("agent-001");
    });

    const firstSend = result.current.sendMessage("Hello");

    await initPromise;

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
      expect(mockStreamChatResponse.mock.calls[0]?.[1]).toBe("Hello");
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      onDone?.({ messageId: "msg-001" });
    });

    await expect(firstSend).resolves.toBeUndefined();
  });

  it("flushes queued first send even when sendMessage closure sees stale null session", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    const staleSendMessage = result.current.sendMessage;

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    let onDone: ((data: { messageId: string }) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onDone = handlers.onDone as typeof onDone;
      return { close: vi.fn(), isConnected: () => true };
    });

    let firstSend!: Promise<void>;
    await act(async () => {
      firstSend = staleSendMessage("Hello from stale sender");
    });

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
      expect(mockStreamChatResponse.mock.calls[0]?.[1]).toBe("Hello from stale sender");
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      onDone?.({ messageId: "msg-001" });
    });

    await expect(firstSend).resolves.toBeUndefined();
    await waitFor(() => {
      expect(result.current.messages.at(-1)).toEqual(expect.objectContaining({
        role: "assistant",
      }));
      expect(result.current.isStreaming).toBe(false);
    });
  });

  it("recovers a queued send when the streaming flag is stuck after a dropped stream", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    // The server confirms no generation is actually in flight: the first
    // stream died without delivering onDone/onError (e.g. mobile tab
    // suspension dropped the SSE connection).
    mockFetchChatSession.mockResolvedValue({
      session: { ...session, isGenerating: false },
    });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });
    await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

    // First send: the stream attaches but never completes and its socket is no
    // longer OPEN (the tab was suspended), so isStreaming stays stuck true with
    // a dead-but-non-null stream ref.
    const closeSpy = vi.fn();
    mockStreamChatResponse.mockReturnValue({ close: closeSpy, isConnected: () => false });
    await act(async () => {
      void result.current.sendMessage("First");
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));
    expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);

    // Second send while the flag is stuck. It must NOT strand in the composer:
    // the stale flag is detected (server says not generating) and the message
    // is delivered to the agent.
    await act(async () => {
      void result.current.sendMessage("Second");
    });

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
      expect(mockStreamChatResponse.mock.calls[1]?.[1]).toBe("Second");
    });
    expect(result.current.pendingMessage).toBe("");
  });

  it("delivers a queued message via the watchdog when a stream stalls after the send was queued", async () => {
    vi.useFakeTimers();
    try {
      const session = makeSession({ id: "session-001", agentId: "agent-001" });
      mockFetchResumeChatSession.mockResolvedValue({ session });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      // Server confirms nothing is generating: the stream died after we queued.
      mockFetchChatSession.mockResolvedValue({
        session: { ...session, isGenerating: false },
      });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      // First send attaches a stream that is connected at send time but never
      // completes (onDone/onError never fire).
      let connected = true;
      mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => connected });
      await act(async () => {
        void result.current.sendMessage("First");
      });

      // Second send while streaming: queued. The send-time recovery sees the
      // stream still connected, so it correctly leaves the message queued to be
      // flushed by the stream's onDone — which never arrives.
      await act(async () => {
        void result.current.sendMessage("Second");
      });
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);

      // The stream goes dead. The watchdog re-confirms after its delay and, since
      // the server reports no generation in flight, delivers the queued message.
      connected = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
      expect(mockStreamChatResponse.mock.calls[1]?.[1]).toBe("Second");
      expect(result.current.pendingMessage).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendMessage returns a promise that resolves on stream completion", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession).not.toBeNull();
    });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onDone?.({ messageId: "msg-001" });
      }, 0);
      return { close: vi.fn(), isConnected: () => true };
    });

    const sendResult = result.current.sendMessage("Hello");
    await expect(sendResult).resolves.toBeUndefined();
  });

  it("sets isStreaming true during first send and clears on delayed done", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onDone?.({ messageId: "msg-001" });
      }, 200);
      return { close: vi.fn(), isConnected: () => true };
    });

    void act(() => {
      void result.current.sendMessage("Hello");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });
  });

  it("uses done payload assistant snapshot when no text chunks were streamed", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onDone?.({
          messageId: "msg-001",
          message: {
            id: "msg-001",
            sessionId: "session-001",
            role: "assistant",
            content: "Snapshot reply",
            thinkingOutput: null,
            metadata: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          } as any,
        });
      }, 0);
      return { close: vi.fn(), isConnected: () => true };
    });

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    await waitFor(() => {
      expect(result.current.messages.at(-1)).toEqual(expect.objectContaining({
        id: "msg-001",
        role: "assistant",
        content: "Snapshot reply",
      }));
    });
  });

  it("prefers accumulated streamed text over done payload snapshot when both exist", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    let onText: ((data: string) => void) | undefined;
    let onDone: ((data: { messageId: string; message?: any }) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onText = handlers.onText;
      onDone = handlers.onDone as typeof onDone;
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      void result.current.sendMessage("Hello");
      onText?.("Quick.");
      onText?.(" Chat.");
      onDone?.({
        messageId: "msg-002",
        message: {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "Quick.Chat.",
          thinkingOutput: null,
          metadata: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.messages.at(-1)).toEqual(expect.objectContaining({
        id: "msg-002",
        content: "Quick. Chat.",
      }));
    });
  });

  it("startModelChat creates a KB session with provider/model override", async () => {
    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.startModelChat("anthropic", "claude-sonnet-4-5");
    });

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        {
          agentId: FN_AGENT_ID,
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
        },
        "proj-123",
      );
    });
  });

  it("switchSession with only agentId creates session without model params", async () => {
    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        { agentId: "agent-001" },
        "proj-123",
      );
      // Ensure model params are not included
      const callArg = mockCreateChatSession.mock.calls[0][0];
      expect(callArg).not.toHaveProperty("modelProvider");
      expect(callArg).not.toHaveProperty("modelId");
    });
  });

  it("switchSession falls back to KB agent when no explicit agent is provided", async () => {
    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("", "openai", "gpt-4o");
    });

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        {
          agentId: FN_AGENT_ID,
          modelProvider: "openai",
          modelId: "gpt-4o",
        },
        "proj-123",
      );
    });
  });

  it("persists the last opened session id when a session becomes active", async () => {
    const firstSession = makeSession({ id: "session-agent-1", agentId: "agent-001" });
    const secondSession = makeSession({ id: "session-agent-2", agentId: "agent-002" });
    mockFetchResumeChatSession
      .mockResolvedValueOnce({ session: firstSession })
      .mockResolvedValueOnce({ session: secondSession });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-agent-1");
      expect(getPersistedLastQuickChatSessionId("proj-123")).toBe("session-agent-1");
    });

    await act(async () => {
      await result.current.switchSession("agent-002");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-agent-2");
      expect(getPersistedLastQuickChatSessionId("proj-123")).toBe("session-agent-2");
    });
  });

  it("switchSession with different model selections creates distinct sessions", async () => {
    const modelASession = makeSession({
      id: "session-model-a",
      agentId: "agent-001",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });

    mockCreateChatSession
      .mockResolvedValueOnce({ session: modelASession })
      .mockResolvedValueOnce({
        session: makeSession({
          id: "session-model-b",
          agentId: "agent-001",
          modelProvider: "openai",
          modelId: "gpt-4o",
        }),
      });

    mockFetchResumeChatSession
      .mockResolvedValueOnce({ session: null })
      .mockResolvedValueOnce({ session: null });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001", "anthropic", "claude-sonnet-4-5");
    });

    await act(async () => {
      await result.current.switchSession("agent-001", "openai", "gpt-4o");
    });

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenNthCalledWith(
        1,
        {
          agentId: "agent-001",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
        },
        "proj-123",
      );

      expect(mockCreateChatSession).toHaveBeenNthCalledWith(
        2,
        {
          agentId: "agent-001",
          modelProvider: "openai",
          modelId: "gpt-4o",
        },
        "proj-123",
      );
    });
  });

  it("clears active session and messages when the project changes", async () => {
    const session = makeSession({ id: "session-existing", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValueOnce({ session });
    mockFetchChatMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-1",
          sessionId: "session-existing",
          role: "assistant",
          content: "Existing project reply",
          createdAt: "2026-05-16T00:00:00.000Z",
          metadata: null,
          thinkingOutput: null,
        } as any,
      ],
    });

    const { result, rerender } = renderHook(({ projectId }) => useQuickChat(projectId), {
      initialProps: { projectId: "proj-123" },
    });

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-existing");
      expect(result.current.messages).toEqual([
        expect.objectContaining({ id: "msg-1", content: "Existing project reply" }),
      ]);
    });

    rerender({ projectId: "proj-456" });

    await waitFor(() => {
      expect(result.current.activeSession).toBeNull();
      expect(result.current.messages).toEqual([]);
      expect(result.current.sessions).toEqual([]);
    });
  });

  it("switchSession with the same target reloads messages instead of creating a new session", async () => {
    const existingSession = makeSession({
      id: "session-existing",
      agentId: "agent-001",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001", "openai", "gpt-4o");
    });

    await act(async () => {
      await result.current.switchSession("agent-001", "openai", "gpt-4o");
    });

    await waitFor(() => {
      expect(mockCreateChatSession).not.toHaveBeenCalled();
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-existing", { limit: 50, order: "desc" }, "proj-123");
    });
  });

  it("switchSession preserves isStreaming when same session is resumed", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-existing", { limit: 50, order: "desc" }, "proj-123");
    });
  });

  it("switchSession resets streaming state when switching to a different session", async () => {
    const sessionA = makeSession({ id: "session-a", agentId: "agent-001" });
    const sessionB = makeSession({ id: "session-b", agentId: "agent-002" });
    const closeFn = vi.fn();

    mockFetchResumeChatSession
      .mockResolvedValueOnce({ session: sessionA })
      .mockResolvedValueOnce({ session: sessionB });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockReturnValue({ close: closeFn, isConnected: () => true });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    await act(async () => {
      await result.current.switchSession("agent-002");
    });

    await waitFor(() => {
      expect(closeFn).toHaveBeenCalledTimes(1);
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.streamingText).toBe("");
      expect(result.current.streamingThinking).toBe("");
      expect(result.current.streamingToolCalls).toEqual([]);
    });
  });

  it("resumes via targeted lookup without loading the full active-session list", async () => {
    const existingSession = makeSession({
      id: "session-targeted",
      agentId: "agent-001",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatSessions.mockRejectedValue(new Error("should not enumerate active sessions"));

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001", "openai", "gpt-4o");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-targeted");
      expect(mockFetchResumeChatSession).toHaveBeenCalledWith(
        {
          agentId: "agent-001",
          modelProvider: "openai",
          modelId: "gpt-4o",
        },
        "proj-123",
      );
      expect(mockFetchChatSessions).not.toHaveBeenCalled();
    });
  });

  it("startFreshSession creates a second session for the same model target", async () => {
    const existingSession = makeSession({
      id: "session-existing",
      agentId: FN_AGENT_ID,
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    const freshSession = makeSession({
      id: "session-fresh",
      agentId: FN_AGENT_ID,
      modelProvider: "openai",
      modelId: "gpt-4o",
    });

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockCreateChatSession.mockResolvedValueOnce({ session: freshSession });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.startModelChat("openai", "gpt-4o");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-existing");
    });

    await act(async () => {
      await result.current.startFreshSession();
    });

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        {
          agentId: FN_AGENT_ID,
          modelProvider: "openai",
          modelId: "gpt-4o",
        },
        "proj-123",
      );
      expect(result.current.activeSession?.id).toBe("session-fresh");
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-fresh", { limit: 50, order: "desc" }, "proj-123");
    });
  });

  it("startFreshSession clears queued pending message state", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const freshSession = makeSession({ id: "session-fresh", agentId: "agent-001" });

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockCreateChatSession.mockResolvedValueOnce({ session: freshSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(result.current.pendingMessage).toBe("Queued follow-up");
    });

    await act(async () => {
      await result.current.startFreshSession();
    });

    await waitFor(() => {
      expect(result.current.pendingMessage).toBe("");
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.activeSession?.id).toBe("session-fresh");
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-existing"))).toBeNull();
  });

  it("stopStreaming aborts stream and resets streaming state", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const closeFn = vi.fn();

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockReturnValue({ close: closeFn, isConnected: () => true });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.stopStreaming();
    });

    await waitFor(() => {
      expect(closeFn).toHaveBeenCalled();
      expect(mockCancelChatResponse).toHaveBeenCalledWith("session-existing", "proj-123");
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.streamingText).toBe("");
      expect(result.current.streamingThinking).toBe("");
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
    });
  });

  it("stopStreaming sends queued pendingMessage after cancelling the stream", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const closeFn = vi.fn();

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockReturnValue({ close: closeFn, isConnected: () => true });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      void result.current.sendMessage("Queued follow-up");
      result.current.stopStreaming();
    });

    await waitFor(() => {
      expect(closeFn).toHaveBeenCalled();
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
      expect(mockStreamChatResponse.mock.calls[1]?.[1]).toBe("Queued follow-up");
      expect(result.current.pendingMessage).toBe("");
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-existing"))).toBeNull();
  });

  it("restored quick-chat queued message auto-sends once after generation already completed", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    localStorage.setItem(getChatPendingMessageKey("session-existing")!, "Queued follow-up");

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
      expect(mockStreamChatResponse.mock.calls[0]?.[1]).toBe("Queued follow-up");
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-existing"))).toBeNull();
  });

  it("stopStreaming with no pendingMessage cancels stream without sending anything", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const closeFn = vi.fn();

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockReturnValue({ close: closeFn, isConnected: () => true });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
      result.current.stopStreaming();
    });

    await waitFor(() => {
      expect(closeFn).toHaveBeenCalled();
      expect(result.current.pendingMessage).toBe("");
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
    });
  });

  it("clearPendingMessage removes persisted quick-chat queue entry", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      void result.current.sendMessage("Hello");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      void result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(result.current.pendingMessage).toBe("Queued follow-up");
    });

    act(() => {
      result.current.clearPendingMessage();
    });

    expect(result.current.pendingMessage).toBe("");
    expect(localStorage.getItem(getChatPendingMessageKey("session-existing"))).toBeNull();
  });

  it("preserves queued quick-chat messages across switchSession and restores them when returning", async () => {
    const sessionA = {
      ...makeSession({ id: "session-a", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        streamingText: "partial",
        streamingThinking: "",
        toolCalls: [],
      },
    };
    const sessionB = makeSession({ id: "session-b", agentId: "agent-002" });

    mockFetchResumeChatSession
      .mockResolvedValueOnce({ session: sessionA })
      .mockResolvedValueOnce({ session: sessionB })
      .mockResolvedValueOnce({ session: sessionA });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-a");
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      void result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(result.current.pendingMessage).toBe("Queued follow-up");
      expect(localStorage.getItem(getChatPendingMessageKey("session-a"))).toBe("Queued follow-up");
    });

    await act(async () => {
      await result.current.switchSession("agent-002");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-b");
      expect(result.current.pendingMessage).toBe("");
      expect(result.current.isStreaming).toBe(false);
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-a"))).toBe("Queued follow-up");

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-a");
      expect(result.current.pendingMessage).toBe("Queued follow-up");
      expect(result.current.isStreaming).toBe(true);
    });
  });

  it("preserves queued quick-chat messages across selectSession and restores them when reselecting", async () => {
    const sessionA = {
      ...makeSession({ id: "session-a", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        streamingText: "partial",
        streamingThinking: "",
        toolCalls: [],
      },
    };
    const sessionB = makeSession({ id: "session-b", agentId: "agent-002" });

    mockFetchChatSession
      .mockResolvedValueOnce({ session: sessionA })
      .mockResolvedValueOnce({ session: sessionB })
      .mockResolvedValueOnce({ session: sessionA });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.selectSession(sessionA);
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-a");
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      void result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(result.current.pendingMessage).toBe("Queued follow-up");
      expect(localStorage.getItem(getChatPendingMessageKey("session-a"))).toBe("Queued follow-up");
    });

    await act(async () => {
      await result.current.selectSession(sessionB);
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-b");
      expect(result.current.pendingMessage).toBe("");
      expect(result.current.isStreaming).toBe(false);
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-a"))).toBe("Queued follow-up");

    await act(async () => {
      await result.current.selectSession(sessionA);
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-a");
      expect(result.current.pendingMessage).toBe("Queued follow-up");
      expect(result.current.isStreaming).toBe(true);
    });
  });

  it("does not flush a restored queued message while the server still reports an in-flight generation", async () => {
    // Mirrors the useChat FN-5852 regression: the locally-held session has a
    // stale falsy isGenerating, but the server is still generating. The
    // restored queued message must wait for the authoritative fetch instead
    // of flushing immediately (which would abort the live generation).
    const staleSessionA = makeSession({ id: "session-a", agentId: "agent-001" });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchChatSession.mockResolvedValue({
      session: {
        ...staleSessionA,
        isGenerating: true,
        inFlightGeneration: {
          streamingText: "partial",
          streamingThinking: "",
          toolCalls: [],
        },
      },
    });

    const attachHandlers: Array<Parameters<typeof mockAttachChatStream>[1]> = [];
    mockAttachChatStream.mockImplementation((_sessionId, nextHandlers) => {
      attachHandlers.push(nextHandlers);
      return { close: vi.fn(), isConnected: () => true };
    });

    localStorage.setItem(getChatPendingMessageKey("session-a")!, "Queued follow-up");

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.selectSession(staleSessionA);
    });

    await waitFor(() => {
      expect(result.current.pendingMessage).toBe("Queued follow-up");
      expect(result.current.isStreaming).toBe(true);
    });

    expect(mockStreamChatResponse).not.toHaveBeenCalled();
    expect(localStorage.getItem(getChatPendingMessageKey("session-a"))).toBe("Queued follow-up");

    // The hook attached to the in-flight generation rather than flushing.
    expect(mockAttachChatStream).toHaveBeenCalledTimes(1);
    expect(attachHandlers.length).toBeGreaterThan(0);

    // Once the attached generation completes, the queued message flushes.
    act(() => {
      attachHandlers[0]?.onDone?.({ messageId: "msg-001" });
    });

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
      expect(mockStreamChatResponse.mock.calls[0]?.[0]).toBe("session-a");
      expect(mockStreamChatResponse.mock.calls[0]?.[1]).toBe("Queued follow-up");
      expect(result.current.pendingMessage).toBe("");
      expect(localStorage.getItem(getChatPendingMessageKey("session-a"))).toBeNull();
    });
  });

  it("does not let the session-activation auto-flush send a restored queue while server validation is pending", async () => {
    // The restore effect's fetchChatSession check takes one network RTT in
    // production. The session-activation auto-flush effect runs in the same
    // commit that restores pendingMessageRef, so without the pre-session
    // gate it would send the restored queue before the check resolves and
    // re-open the stale-isGenerating loss path (FN-5852).
    const staleSessionA = makeSession({ id: "session-a", agentId: "agent-001" });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    // Server check never resolves within the test — simulates in-flight RTT.
    mockFetchChatSession.mockReturnValue(new Promise(() => {}) as never);

    localStorage.setItem(getChatPendingMessageKey("session-a")!, "Queued follow-up");

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.selectSession(staleSessionA);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    // The restored queue is intact and nothing was sent.
    expect(result.current.pendingMessage).toBe("Queued follow-up");
    expect(mockStreamChatResponse).not.toHaveBeenCalled();
    expect(localStorage.getItem(getChatPendingMessageKey("session-a"))).toBe("Queued follow-up");
  });

  it("pre-session queueing does not write a null localStorage key", async () => {
    const session = makeSession({ id: "session-pre", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValueOnce({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendMessage("Hello before session ready");
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-pre"))).toBeNull();
    expect(localStorage.getItem("fusion:chat-pending:null")).toBeNull();
    expect(localStorage.getItem("fusion:chat-pending:undefined")).toBeNull();

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await expect(sendPromise).resolves.toBeUndefined();
    expect(localStorage.getItem(getChatPendingMessageKey("session-pre"))).toBeNull();
    expect(localStorage.getItem("fusion:chat-pending:null")).toBeNull();
    expect(localStorage.getItem("fusion:chat-pending:undefined")).toBeNull();
  });

  it("sending during streaming queues message without warning toast", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const addToast = vi.fn();

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { result } = renderHook(() => useQuickChat("proj-123", addToast));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
    });

    expect(result.current.pendingMessage).toBe("Queued follow-up");
    expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
    expect(addToast).not.toHaveBeenCalledWith("Still waiting for previous response — message queued", "warning");
  });

  it("starts a fresh stream and shows active state on second turn after first turn completes", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const handlers: Array<Parameters<typeof mockStreamChatResponse>[2]> = [];

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockImplementation((_sessionId, _content, nextHandlers) => {
      handlers.push(nextHandlers);
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      void result.current.sendMessage("Turn 1");
    });

    expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);

    act(() => {
      handlers[0]?.onDone?.({ messageId: "msg-001" });
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });

    act(() => {
      void result.current.sendMessage("Turn 2");
    });

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      handlers[1]?.onError?.("second turn failed");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });
  });

  it("persists queued quick-chat message text to localStorage while streaming", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      void result.current.sendMessage("Hello");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      void result.current.sendMessage("Queued follow-up");
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-existing"))).toBe("Queued follow-up");
  });

  it("rehydrates queued quick-chat message from localStorage after remount", async () => {
    const existingSession = {
      ...makeSession({ id: "session-existing", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        streamingText: "partial",
        streamingThinking: "",
        toolCalls: [],
      },
    };
    mockFetchResumeChatSession.mockResolvedValue({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const firstHook = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await firstHook.result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(firstHook.result.current.isStreaming).toBe(true);
    });

    act(() => {
      void firstHook.result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(localStorage.getItem(getChatPendingMessageKey("session-existing"))).toBe("Queued follow-up");
    });

    firstHook.unmount();

    const secondHook = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await secondHook.result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(secondHook.result.current.pendingMessage).toBe("Queued follow-up");
    });
  });

  describe("message queue behavior", () => {
    it("queued message is auto-sent after streaming onDone", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const handlers: Array<Parameters<typeof mockStreamChatResponse>[2]> = [];

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockImplementation((_sessionId, _content, nextHandlers) => {
      handlers.push(nextHandlers);
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
    });

    act(() => {
      handlers[0]?.onDone?.({ messageId: "msg-001" });
    });

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
      expect(mockStreamChatResponse.mock.calls[1]?.[1]).toBe("Queued follow-up");
      expect(result.current.pendingMessage).toBe("");
    });
  });

    it("resolves current send promise and creates a new completion for queued send", async () => {
      const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
      const handlers: Array<Parameters<typeof mockStreamChatResponse>[2]> = [];

      mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockStreamChatResponse.mockImplementation((_sessionId, _content, nextHandlers) => {
        handlers.push(nextHandlers);
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      let firstSend: Promise<void>;
      await act(async () => {
        firstSend = result.current.sendMessage("First");
      });

      act(() => {
        void result.current.sendMessage("Queued follow-up");
      });

      await act(async () => {
        handlers[0]?.onDone?.({ messageId: "msg-001" });
      });

      await expect(firstSend!).resolves.toBeUndefined();

      await waitFor(() => {
        expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
        expect(result.current.isStreaming).toBe(true);
      });

      await act(async () => {
        handlers[1]?.onDone?.({ messageId: "msg-002" });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });
  });

  describe("queued message recovery paths", () => {
    it("flushes queued message when attached recovery stream completes", async () => {
      const existingSession = {
        ...makeSession({ id: "session-existing", agentId: "agent-001" }),
        isGenerating: true,
      };
      const attachHandlers: Array<Parameters<typeof mockAttachChatStream>[1]> = [];

      mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockAttachChatStream.mockImplementation((_sessionId, handlers) => {
        attachHandlers.push(handlers);
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      const queuedSend = result.current.sendMessage("Queued follow-up");

      await waitFor(() => {
        expect(result.current.pendingMessage).toBe("Queued follow-up");
      });

      act(() => {
        attachHandlers[0]?.onDone?.({ messageId: "msg-recovery" });
      });

      await waitFor(() => {
        expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
        expect(mockStreamChatResponse.mock.calls[0]?.[1]).toBe("Queued follow-up");
        expect(result.current.pendingMessage).toBe("");
      });

      await expect(queuedSend).resolves.toBeUndefined();
    });

  });

  it("onError does not remove user message from local state", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    let onErrorHandler: ((data: string) => void) | undefined;

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
        messages: [
          {
            id: "msg-user-1",
            sessionId: existingSession.id,
            role: "user",
            content: "Hello",
            thinkingOutput: null,
            metadata: null,
            createdAt: new Date().toISOString(),
          },
        ],
      });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onErrorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
    });

    expect(result.current.messages.some((message) => message.role === "user" && message.content === "Hello")).toBe(true);

    act(() => {
      onErrorHandler?.("Connection aborted");
    });

    await waitFor(() => {
      expect(result.current.messages.some((message) => message.role === "user" && message.content === "Hello")).toBe(true);
    });
  });

  it("onError reloads messages from server", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    let onErrorHandler: ((data: string) => void) | undefined;

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onErrorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
    });

    act(() => {
      onErrorHandler?.("Connection aborted");
    });

    await waitFor(() => {
      expect(mockFetchChatMessages.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-existing", { limit: 50, order: "desc" }, "proj-123");
    });
  });

  it("onError resets streaming state", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    let onErrorHandler: ((data: string) => void) | undefined;
    let onTextHandler: ((data: string) => void) | undefined;
    let onThinkingHandler: ((data: string) => void) | undefined;

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onErrorHandler = handlers.onError;
      onTextHandler = handlers.onText;
      onThinkingHandler = handlers.onThinking;
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
      onTextHandler?.("Partial answer");
      onThinkingHandler?.("Thinking...");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
      expect(result.current.streamingText).toBe("Partial answer");
      expect(result.current.streamingThinking).toBe("Thinking...");
    });

    act(() => {
      onErrorHandler?.("Connection aborted");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.streamingText).toBe("");
      expect(result.current.streamingThinking).toBe("");
    });
  });

  it("onError shows the backend error message in the toast", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const addToast = vi.fn();
    let onErrorHandler: ((data: string) => void) | undefined;

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onErrorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useQuickChat("proj-123", addToast));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      result.current.sendMessage("Hello");
      onErrorHandler?.("No API key for provider: openai-codex");
    });

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("No API key for provider: openai-codex", "error");
    });
  });

  it("suppresses Load failed toast when tab is hidden", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const addToast = vi.fn();
    let onErrorHandler: ((data: string) => void) | undefined;

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onErrorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    setDocumentVisibilityState("hidden");
    const { result } = renderHook(() => useQuickChat("proj-123", addToast));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await act(async () => {
      const sendPromise = result.current.sendMessage("Hello");
      onErrorHandler?.("Load failed");
      await sendPromise;
    });

    await waitFor(() => {
      expect(addToast).not.toHaveBeenCalledWith("Load failed", "error");
    });
  });

  it("suppresses Load failed when tab remains visible", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const addToast = vi.fn();
    let onErrorHandler: ((data: string) => void) | undefined;

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onErrorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    setDocumentVisibilityState("visible");
    const { result } = renderHook(() => useQuickChat("proj-123", addToast));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await act(async () => {
      const sendPromise = result.current.sendMessage("Hello");
      onErrorHandler?.("Load failed");
      await sendPromise;
    });

    await waitFor(() => {
      expect(addToast).not.toHaveBeenCalledWith("Load failed", "error");
      expect(mockFetchChatSession).toHaveBeenCalledWith("session-existing", "proj-123");
    });
  });

  it("suppresses Failed to fetch shortly after hidden to visible transition", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const addToast = vi.fn();
    let onErrorHandler: ((data: string) => void) | undefined;

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onErrorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    setDocumentVisibilityState("hidden");
    const { result } = renderHook(() => useQuickChat("proj-123", addToast));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await act(async () => {
      setDocumentVisibilityState("visible");
      const sendPromise = result.current.sendMessage("Hello");
      onErrorHandler?.("Failed to fetch");
      await sendPromise;
    });

    await waitFor(() => {
      expect(addToast).not.toHaveBeenCalledWith("Failed to fetch", "error");
    });
  });

  it("reattaches with replayFromEventId when tab becomes visible and server is generating", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const generatingSession = {
      ...existingSession,
      isGenerating: true,
      inFlightGeneration: {
        status: "generating" as const,
        streamingText: "partial",
        streamingThinking: "thinking",
        toolCalls: [],
        replayFromEventId: 17,
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    };
    const addToast = vi.fn();

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatSession.mockResolvedValueOnce({ session: generatingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useQuickChat("proj-123", addToast));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      setDocumentVisibilityState("hidden");
      setDocumentVisibilityState("visible");
    });

    await waitFor(() => {
      expect(mockAttachChatStream).toHaveBeenCalledWith(
        "session-existing",
        expect.any(Object),
        "proj-123",
        { lastEventId: 17 },
      );
      expect(addToast).not.toHaveBeenCalled();
    });
  });

  it("visibility reconnect failure is silent and only runs without a live stream", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const addToast = vi.fn();

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchChatSession.mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useQuickChat("proj-123", addToast));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    act(() => {
      setDocumentVisibilityState("hidden");
      setDocumentVisibilityState("visible");
    });

    await waitFor(() => {
      expect(mockFetchChatSession).toHaveBeenCalledWith("session-existing", "proj-123");
      expect(addToast).not.toHaveBeenCalled();
    });

    mockFetchChatSession.mockClear();
    act(() => {
      result.current.sendMessage("Hello");
      setDocumentVisibilityState("hidden");
      setDocumentVisibilityState("visible");
    });
    expect(mockFetchChatSession).not.toHaveBeenCalled();
  });

  it("still shows toast for non-suspension errors regardless of visibility", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    const addToast = vi.fn();
    let onErrorHandler: ((data: string) => void) | undefined;

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onErrorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    setDocumentVisibilityState("hidden");
    const { result } = renderHook(() => useQuickChat("proj-123", addToast));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await expect(act(async () => {
      const sendPromise = result.current.sendMessage("Hello");
      onErrorHandler?.("Request failed: 500");
      await sendPromise;
    })).rejects.toThrow("Request failed: 500");

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Request failed: 500", "error");
    });
  });

  it("onFallback updates the active model, persists fallback metadata, and shows a warning toast", async () => {
    const existingSession = makeSession({
      id: "session-existing",
      agentId: FN_AGENT_ID,
      modelProvider: "openai-codex",
      modelId: "gpt-5.3-codex",
    });
    const addToast = vi.fn();
    let onFallbackHandler:
      | ((data: { primaryModel: string; fallbackModel: string; triggerPoint: "session-creation" | "prompt-time" }) => void)
      | undefined;
    let onTextHandler: ((data: string) => void) | undefined;
    let onDoneHandler: ((data: { messageId: string }) => void) | undefined;

    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      onFallbackHandler = handlers.onFallback;
      onTextHandler = handlers.onText;
      onDoneHandler = handlers.onDone;
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useQuickChat("proj-123", addToast));

    await act(async () => {
      await result.current.switchSession(FN_AGENT_ID, "openai-codex", "gpt-5.3-codex");
    });

    act(() => {
      result.current.sendMessage("Hello");
      onFallbackHandler?.({
        primaryModel: "openai-codex/gpt-5.3-codex",
        fallbackModel: "zai/glm-5.1",
        triggerPoint: "prompt-time",
      });
      onTextHandler?.("Fallback reply");
      onDoneHandler?.({ messageId: "msg-fallback" });
    });

    await waitFor(() => {
      expect(result.current.activeSession?.modelProvider).toBe("zai");
      expect(result.current.activeSession?.modelId).toBe("glm-5.1");
      expect(addToast).toHaveBeenCalledWith(
        "Primary model unavailable. Switched to fallback zai/glm-5.1.",
        "warning",
      );
      expect(result.current.messages.at(-1)).toEqual(expect.objectContaining({
        id: "msg-fallback",
        role: "assistant",
        content: "Fallback reply",
        fallbackInfo: {
          primaryModel: "openai-codex/gpt-5.3-codex",
          fallbackModel: "zai/glm-5.1",
          triggerPoint: "prompt-time",
        },
      }));
    });
  });

  describe("regression: init retry limit prevents infinite toast spam", () => {
    it("stops showing error toasts after 3 consecutive initialization failures", async () => {
      const addToast = vi.fn();
      mockFetchResumeChatSession.mockRejectedValue(new Error("API down"));

      const { result } = renderHook(() => useQuickChat("proj-123", addToast));

      // Attempt 1
      await act(async () => {
        await result.current.switchSession("agent-001");
      });
      // Attempt 2
      await act(async () => {
        await result.current.switchSession("agent-001");
      });
      // Attempt 3
      await act(async () => {
        await result.current.switchSession("agent-001");
      });
      // Attempt 4 — should be silently dropped
      await act(async () => {
        await result.current.switchSession("agent-002");
      });

      // Should have exactly 3 toast calls (one per unique target up to the limit)
      // Each new target resets the retry counter, so agent-001 gets 3 toasts
      // and agent-002 starts fresh. But agent-001 only has 3 switchSession calls
      // each with a different internal retry.
      //
      // Actually: switchSession clears the session each time, so each call
      // goes through initializeSession which increments the counter.
      // The counter resets on success or when startFreshSession is called.
      // With 3 calls for agent-001, that's 3 failures = 3 toasts.
      // Then agent-002 starts a new sequence — retry counter continues
      // because it's the same hook instance.
      expect(addToast).toHaveBeenCalledTimes(3);
      expect(addToast).toHaveBeenNthCalledWith(1, "Failed to initialize chat", "error");
      expect(addToast).toHaveBeenNthCalledWith(2, "Failed to initialize chat", "error");
      expect(addToast).toHaveBeenNthCalledWith(3, "Failed to initialize chat", "error");
    });

    it("resets retry counter after a successful initialization", async () => {
      const addToast = vi.fn();

      const session = makeSession({ id: "session-001", agentId: "agent-001" });
      mockFetchResumeChatSession
        .mockRejectedValueOnce(new Error("API down"))
        .mockResolvedValueOnce({ session });

      const { result } = renderHook(() => useQuickChat("proj-123", addToast));

      // Fail once
      await act(async () => {
        await result.current.switchSession("agent-001");
      });
      expect(addToast).toHaveBeenCalledTimes(1);

      // Succeed — resets counter
      await act(async () => {
        await result.current.switchSession("agent-001");
      });
      expect(result.current.activeSession?.id).toBe("session-001");

      // Fail again — counter was reset, so toast shows again
      mockFetchResumeChatSession.mockRejectedValue(new Error("API down again"));
      await act(async () => {
        await result.current.switchSession("agent-002");
      });
      expect(addToast).toHaveBeenCalledTimes(2);
    });
  });

  describe("regression: startFreshSession skip flag prevents useEffect race", () => {
    it("sets skipNextSessionInitRef during startFreshSession and clears it after", async () => {
      const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
      const freshSession = makeSession({ id: "session-fresh", agentId: "agent-001" });

      mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
      mockCreateChatSession.mockResolvedValueOnce({ session: freshSession });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      // Before startFreshSession — flag should be false
      expect(result.current.skipNextSessionInitRef.current).toBe(false);

      // During startFreshSession — the flag is set then cleared in finally
      await act(async () => {
        await result.current.startFreshSession();
      });

      // After startFreshSession — flag should be cleared
      expect(result.current.skipNextSessionInitRef.current).toBe(false);
      expect(result.current.activeSession?.id).toBe("session-fresh");
    });

    it("startFreshSession creates a new session even when an existing one exists for the same agent", async () => {
      const existingSession = makeSession({ id: "session-old", agentId: "agent-001" });
      const freshSession = makeSession({ id: "session-new", agentId: "agent-001" });

      mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingSession });
      mockCreateChatSession.mockResolvedValueOnce({ session: freshSession });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      // First switchSession resumes existing session
      await act(async () => {
        await result.current.switchSession("agent-001");
      });
      expect(result.current.activeSession?.id).toBe("session-old");

      // startFreshSession should bypass resume and create a new one
      await act(async () => {
        await result.current.startFreshSession();
      });

      await waitFor(() => {
        expect(result.current.activeSession?.id).toBe("session-new");
      });

      // createSession was called (not resume)
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        { agentId: "agent-001" },
        "proj-123",
      );
    });
  });

  describe("regression: switchSession uses activeSessionRef to avoid cascading re-renders", () => {
    it("switchSession does not re-initialize when activeSession changes", async () => {
      const sessionA = makeSession({ id: "session-a", agentId: "agent-001" });

      mockFetchResumeChatSession.mockResolvedValue({ session: sessionA });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      expect(result.current.activeSession).not.toBeNull();

      // Calling switchSession again with the same target should NOT
      // go through initializeSession again — it should just reload
      // messages (because activeSessionRef.current is set, making
      // isSameSession = true). This is the key behavioral fix:
      // even though switchSession gets a new identity from other deps,
      // it reads activeSession from a ref so it correctly detects
      // "same session" and skips re-initialization.
      const resumeCallCount = mockFetchResumeChatSession.mock.calls.length;
      const createCallCount = mockCreateChatSession.mock.calls.length;

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      // No additional API calls for session lookup or creation
      expect(mockFetchResumeChatSession.mock.calls.length).toBe(resumeCallCount);
      expect(mockCreateChatSession.mock.calls.length).toBe(createCallCount);

      // Messages were reloaded though
      expect(mockFetchChatMessages).toHaveBeenCalled();
    });

    it("switchSession with same target after activeSession change just reloads messages", async () => {
      const sessionA = makeSession({ id: "session-a", agentId: "agent-001" });

      mockFetchResumeChatSession.mockResolvedValue({ session: sessionA });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      expect(result.current.activeSession?.id).toBe("session-a");

      // Calling switchSession again with same target should reload messages,
      // not call fetchResumeChatSession again
      const initialResumeCallCount = mockFetchResumeChatSession.mock.calls.length;

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      // No additional resume lookup — just message reload
      expect(mockFetchResumeChatSession.mock.calls.length).toBe(initialResumeCallCount);
      expect(mockFetchChatMessages).toHaveBeenCalled();
    });
  });

  describe("FN-3336: streaming state recovery on reload", () => {
    it("hydrates durable in-flight snapshot and resumes from replay point", async () => {
      const session = {
        ...makeSession({ id: "session-001", agentId: "agent-001" }),
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "partial text",
          streamingThinking: "partial thinking",
          toolCalls: [{ toolName: "read", status: "running" as const, isError: false }],
          replayFromEventId: 17,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };
      mockFetchResumeChatSession.mockResolvedValue({ session });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.streamingText).toBe("partial text");
        expect(result.current.streamingThinking).toBe("partial thinking");
        expect(result.current.streamingToolCalls).toHaveLength(1);
      });

      expect(mockAttachChatStream).toHaveBeenCalledWith(
        "session-001",
        expect.any(Object),
        "proj-123",
        { lastEventId: 17 },
      );
    });

    it("FN-5104 reattaches once when selectSession refresh reveals generation from stale cache", async () => {
      const staleSession = {
        ...makeSession({ id: "session-001", agentId: "agent-001" }),
        isGenerating: false,
        inFlightGeneration: null,
      };
      const generatingSession = {
        ...staleSession,
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "partial text",
          streamingThinking: "thinking",
          toolCalls: [{ toolName: "read", status: "running" as const, isError: false }],
          replayFromEventId: 17,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };
      mockFetchChatSession.mockResolvedValueOnce({ session: generatingSession });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.selectSession(staleSession);
      });

      await waitFor(() => {
        expect(mockAttachChatStream).toHaveBeenCalledTimes(1);
        expect(mockAttachChatStream).toHaveBeenCalledWith(
          "session-001",
          expect.any(Object),
          "proj-123",
          { lastEventId: 17 },
        );
        expect(result.current.streamingText).toBe("partial text");
      });
    });

    it("sets isStreaming=true when initializing a session with isGenerating=true", async () => {
      const session = { ...makeSession({ id: "session-001", agentId: "agent-001" }), isGenerating: true };
      mockFetchResumeChatSession.mockResolvedValue({ session });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.streamingText).toBe("");
      });
    });

    it("does not set isStreaming when isGenerating is false", async () => {
      const session = { ...makeSession({ id: "session-001", agentId: "agent-001" }), isGenerating: false };
      mockFetchResumeChatSession.mockResolvedValue({ session });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });

    it("clears recovery streaming state when attach stream completes", async () => {
      const session = { ...makeSession({ id: "session-001", agentId: "agent-001" }), isGenerating: true };
      mockFetchResumeChatSession.mockResolvedValue({ session });
      mockFetchChatMessages.mockResolvedValue({
        messages: [
          { id: "msg-1", sessionId: "session-001", role: "assistant", content: "Done", thinkingOutput: null, metadata: null, createdAt: new Date().toISOString() },
        ],
      });
      mockAttachChatStream.mockImplementation((_sessionId, handlers) => {
        setTimeout(() => handlers.onDone?.({ messageId: "msg-1" }), 0);
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
        expect(result.current.streamingText).toBe("");
        expect(result.current.messages.some((m) => m.id === "msg-1")).toBe(true);
      });
    });
  });

  it("initial load uses order=desc to fetch latest messages first", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchResumeChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(mockFetchChatMessages).toHaveBeenCalledWith(
        "session-001",
        expect.objectContaining({ order: "desc" }),
        "proj-123",
      );
    });
  });

});

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@fusion/core";
import * as apiModule from "../../api";
import { FN_AGENT_ID, useQuickChat } from "../useQuickChat";

vi.mock("../../api", () => ({
  fetchResumeChatSession: vi.fn(),
  fetchChatSessions: vi.fn(),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  streamChatResponse: vi.fn(),
  cancelChatResponse: vi.fn(),
}));

const mockFetchResumeChatSession = vi.mocked(apiModule.fetchResumeChatSession);
const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockFetchChatSession = vi.mocked(apiModule.fetchChatSession);
const mockCreateChatSession = vi.mocked(apiModule.createChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);
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

describe("useQuickChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockCancelChatResponse.mockResolvedValue({ success: true });
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

  it("prefers done payload assistant snapshot over streamed text", async () => {
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
      onText?.("streamed text");
      onDone?.({
        messageId: "msg-002",
        message: {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "snapshot wins",
          thinkingOutput: null,
          metadata: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.messages.at(-1)).toEqual(expect.objectContaining({
        id: "msg-002",
        content: "snapshot wins",
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
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-existing", { limit: 50 }, "proj-123");
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
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-existing", { limit: 50 }, "proj-123");
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
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-fresh", { limit: 50 }, "proj-123");
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
    });
  });

  it("sending during streaming queues message", async () => {
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

    act(() => {
      result.current.sendMessage("Queued follow-up");
    });

    expect(result.current.pendingMessage).toBe("Queued follow-up");
    expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
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
      expect(mockFetchChatMessages).toHaveBeenCalledTimes(2);
      expect(mockFetchChatMessages).toHaveBeenLastCalledWith("session-existing", { limit: 50 }, "proj-123");
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

    it("clears recovery streaming state when polling detects generation complete", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const session = { ...makeSession({ id: "session-001", agentId: "agent-001" }), isGenerating: true };
      mockFetchResumeChatSession.mockResolvedValue({ session });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      // After first poll, server reports generation is done and has a new assistant message
      mockFetchChatSession.mockResolvedValue({
        session: { ...makeSession({ id: "session-001", agentId: "agent-001" }), isGenerating: false },
      });
      mockFetchChatMessages.mockResolvedValue({
        messages: [
          { id: "msg-1", sessionId: "session-001", role: "assistant", content: "Done", thinkingOutput: null, metadata: null, createdAt: new Date().toISOString() },
        ],
      });

      const { result } = renderHook(() => useQuickChat("proj-123"));

      await act(async () => {
        await result.current.switchSession("agent-001");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      // Advance time to trigger the polling interval (3s)
      await act(async () => {
        vi.advanceTimersByTime(3500);
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
        expect(result.current.streamingText).toBe("");
        expect(result.current.messages.some((m) => m.id === "msg-1")).toBe(true);
      });

      vi.useRealTimers();
    });
  });
});

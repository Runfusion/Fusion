import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@fusion/core";
import * as apiModule from "../../api";
import { FN_AGENT_ID, useQuickChat } from "../useQuickChat";

vi.mock("../../api", () => ({
  fetchResumeChatSession: vi.fn(),
  fetchChatSessions: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  streamChatResponse: vi.fn(),
  cancelChatResponse: vi.fn(),
}));

const mockFetchResumeChatSession = vi.mocked(apiModule.fetchResumeChatSession);
const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
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

  it("onError shows toast with failed response message", async () => {
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
      onErrorHandler?.("Connection aborted");
    });

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Failed to get response", "error");
    });
  });
});

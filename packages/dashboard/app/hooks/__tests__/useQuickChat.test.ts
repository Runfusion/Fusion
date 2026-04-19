import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@fusion/core";
import * as apiModule from "../../api";
import { KB_AGENT_ID, useQuickChat } from "../useQuickChat";

vi.mock("../../api", () => ({
  fetchChatSessions: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  streamChatResponse: vi.fn(),
}));

const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockCreateChatSession = vi.mocked(apiModule.createChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);

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
    mockFetchChatSessions.mockResolvedValue({ sessions: [] });
    mockCreateChatSession.mockResolvedValue({
      session: makeSession({ id: "session-001", agentId: "agent-001" }),
    });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  });

  it("sendMessage is synchronous and returns void", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValue({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.switchSession("agent-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession).not.toBeNull();
    });

    // sendMessage should return void (undefined), not a Promise
    const sendResult = result.current.sendMessage("Hello");
    expect(sendResult).toBeUndefined();
  });

  it("startModelChat creates a KB session with provider/model override", async () => {
    const { result } = renderHook(() => useQuickChat("proj-123"));

    await act(async () => {
      await result.current.startModelChat("anthropic", "claude-sonnet-4-5");
    });

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        {
          agentId: KB_AGENT_ID,
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
          agentId: KB_AGENT_ID,
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

    mockFetchChatSessions
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce({ sessions: [modelASession] });

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

    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [existingSession] });

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

  it("onError does not remove user message from local state", async () => {
    const existingSession = makeSession({ id: "session-existing", agentId: "agent-001" });
    let onErrorHandler: ((data: string) => void) | undefined;

    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [existingSession] });
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
        messages: [
          {
            id: "msg-user-1",
            sessionId: existingSession.id,
            role: "user",
            content: "Hello",
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

    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [existingSession] });
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

    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [existingSession] });
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

    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [existingSession] });
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

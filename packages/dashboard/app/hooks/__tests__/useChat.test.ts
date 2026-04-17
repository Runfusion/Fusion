/**
 * Tests for useChat hook: session management, message loading, SSE streaming,
 * search/filter, and pagination.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../useChat";
import * as apiModule from "../../api";
import type { ChatSession, ChatMessage } from "@fusion/core";

// Mock the API module
vi.mock("../../api", () => ({
  fetchChatSessions: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  streamChatResponse: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([
    { id: "agent-001", name: "Alpha", role: "executor", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
    { id: "agent-002", name: "Beta", role: "reviewer", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
  ]),
}));

// Mock the projectStorage module
vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
}));

import * as projectStorageModule from "../../utils/projectStorage";

const mockGetScopedItem = vi.mocked(projectStorageModule.getScopedItem);
const mockSetScopedItem = vi.mocked(projectStorageModule.setScopedItem);
const mockRemoveScopedItem = vi.mocked(projectStorageModule.removeScopedItem);

const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockCreateChatSession = vi.mocked(apiModule.createChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockUpdateChatSession = vi.mocked(apiModule.updateChatSession);
const mockDeleteChatSession = vi.mocked(apiModule.deleteChatSession);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);
const mockFetchAgents = vi.mocked(apiModule.fetchAgents);

function makeSession(overrides: Partial<ChatSession> & Pick<ChatSession, "id" | "agentId">): ChatSession {
  return {
    id: overrides.id,
    agentId: overrides.agentId,
    status: overrides.status ?? "active",
    title: overrides.title,
    modelProvider: overrides.modelProvider,
    modelId: overrides.modelId,
    createdAt: overrides.createdAt ?? "2026-04-08T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-08T00:00:00.000Z",
  };
}

function makeMessage(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "sessionId" | "role" | "content">): ChatMessage {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId,
    role: overrides.role,
    content: overrides.content,
    thinkingOutput: overrides.thinkingOutput,
    createdAt: overrides.createdAt ?? "2026-04-08T00:00:00.000Z",
  };
}

describe("useChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchChatSessions.mockResolvedValue({ sessions: [] });
    mockCreateChatSession.mockResolvedValue({
      session: makeSession({ id: "session-001", agentId: "agent-001", title: "New Chat" }),
    });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockUpdateChatSession.mockResolvedValue({
      session: makeSession({ id: "session-001", agentId: "agent-001", status: "archived" }),
    });
    mockDeleteChatSession.mockResolvedValue({ success: true });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads sessions on mount", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        makeSession({ id: "session-001", agentId: "agent-001" }),
        makeSession({ id: "session-002", agentId: "agent-002" }),
      ],
    });

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(mockFetchChatSessions).toHaveBeenCalledWith("proj-123");
    });

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    expect(result.current.sessions[0]?.id).toBe("session-001");
    expect(result.current.sessions[1]?.id).toBe("session-002");
  });

  it("sendMessage is synchronous and returns void", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    // sendMessage should return void (undefined), not a Promise
    const sendResult = result.current.sendMessage("Hello");
    expect(sendResult).toBeUndefined();
  });

  it("populates agentsMap on mount", async () => {
    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(result.current.agentsMap.size).toBe(2);
    });

    expect(result.current.agentsMap.get("agent-001")?.name).toBe("Alpha");
    expect(result.current.agentsMap.get("agent-002")?.name).toBe("Beta");
  });

  it("selects a session and loads its messages", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [
        makeMessage({ id: "msg-001", sessionId: "session-001", role: "user", content: "Hello" }),
        makeMessage({ id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi there" }),
      ],
    });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-001", { limit: 50 }, undefined);
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.activeSession?.id).toBe("session-001");
    });
  });

  it("loads BOTH user and assistant messages when selecting a session", async () => {
    // This test verifies the fix for FN-1857: Chat assistant messages not persisted
    // after navigating away. The selectSession should fetch ALL messages from the server,
    // including both user and assistant messages.
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });

    // Simulate a conversation with multiple user and assistant messages
    // in backend chronological order (oldest first)
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [
        makeMessage({ id: "msg-001", sessionId: "session-001", role: "user", content: "First question" }),
        makeMessage({ id: "msg-002", sessionId: "session-001", role: "assistant", content: "First answer" }),
        makeMessage({ id: "msg-003", sessionId: "session-001", role: "user", content: "Second question" }),
        makeMessage({ id: "msg-004", sessionId: "session-001", role: "assistant", content: "Second answer" }),
      ],
    });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(4);
    });

    // Verify all messages are loaded in correct order
    expect(result.current.messages[0]).toMatchObject({
      id: "msg-001",
      role: "user",
      content: "First question",
    });
    expect(result.current.messages[1]).toMatchObject({
      id: "msg-002",
      role: "assistant",
      content: "First answer",
    });
    expect(result.current.messages[2]).toMatchObject({
      id: "msg-003",
      role: "user",
      content: "Second question",
    });
    expect(result.current.messages[3]).toMatchObject({
      id: "msg-004",
      role: "assistant",
      content: "Second answer",
    });
  });

  it("creates a new session and selects it", async () => {
    const newSession = makeSession({ id: "session-new", agentId: "agent-001", title: "Test Chat" });
    mockCreateChatSession.mockResolvedValueOnce({ session: newSession });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [] });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessionsLoading).toBe(false);
    });

    let createdSession: ReturnType<typeof result.current.createSession> extends Promise<infer T> ? T : never;
    await act(async () => {
      createdSession = await result.current.createSession({
        agentId: "agent-001",
        title: "Test Chat",
      });
    });

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        { agentId: "agent-001", title: "Test Chat" },
        undefined,
      );
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-new");
      expect(result.current.sessions).toHaveLength(1);
    });
  });

  it("archives a session", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    await act(async () => {
      await result.current.archiveSession("session-001");
    });

    await waitFor(() => {
      expect(mockUpdateChatSession).toHaveBeenCalledWith("session-001", { status: "archived" }, undefined);
    });

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(0);
    });
  });

  it("deletes a session", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    await act(async () => {
      await result.current.deleteSession("session-001");
    });

    await waitFor(() => {
      expect(mockDeleteChatSession).toHaveBeenCalledWith("session-001", undefined);
    });

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(0);
    });
  });

  it("sends a message and receives streaming response", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

    // Track stream close call
    const closeFn = vi.fn();
    let textHandler: ((data: string) => void) | undefined;
    let doneHandler: ((data: { messageId: string }) => void) | undefined;

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      textHandler = handlers.onText;
      doneHandler = handlers.onDone;
      return { close: closeFn, isConnected: () => true };
    });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(0);
    });

    // Simulate sending a message
    await act(async () => {
      await result.current.sendMessage("Hello!");
    });

    await waitFor(() => {
      // Optimistic user message should be added
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]?.role).toBe("user");
      expect(result.current.messages[0]?.content).toBe("Hello!");
      expect(result.current.isStreaming).toBe(true);
    });

    // Simulate streaming text
    await act(async () => {
      textHandler?.("Hello ");
      textHandler?.("there!");
    });

    await waitFor(() => {
      expect(result.current.streamingText).toBe("Hello there!");
    });

    // Simulate completion
    await act(async () => {
      doneHandler?.({ messageId: "msg-002" });
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
      // User message should be preserved, assistant message added
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0]?.role).toBe("user");
      expect(result.current.messages[0]?.content).toBe("Hello!");
      expect(result.current.messages[1]?.role).toBe("assistant");
      expect(result.current.messages[1]?.id).toBe("msg-002");
      expect(result.current.streamingText).toBe("");
    });
  });

  it("handles stream errors", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

    let errorHandler: ((data: string) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      errorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await act(async () => {
      await result.current.sendMessage("Hello!");
    });

    // Simulate error
    await act(async () => {
      errorHandler?.("Stream connection failed");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.messages).toHaveLength(0);
    });
  });

  it("loads more messages with pagination", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });

    // Return 50 messages for initial load to keep hasMoreMessages=true, then 1 for loadMore
    const make50Messages = () =>
      Array.from({ length: 50 }, (_, i) => makeMessage({ id: `msg-${i}`, sessionId: "session-001", role: "user", content: `Message ${i}` }));

    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: make50Messages() })
      .mockResolvedValueOnce({ messages: [makeMessage({ id: "msg-old", sessionId: "session-001", role: "user", content: "Old message" })] });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(50);
      expect(result.current.hasMoreMessages).toBe(true);
    });

    // Before loadMoreMessages
    const callCountBefore = mockFetchChatMessages.mock.calls.length;

    await act(async () => {
      await result.current.loadMoreMessages();
    });

    // Verify that loadMoreMessages triggered a new fetch
    await waitFor(() => {
      expect(mockFetchChatMessages.mock.calls.length).toBeGreaterThan(callCountBefore);
    });

    // Verify the second call had pagination params
    const secondCall = mockFetchChatMessages.mock.calls[1];
    expect(secondCall[0]).toBe("session-001");
    expect(secondCall[1]).toHaveProperty("limit");
    expect(secondCall[1]).toHaveProperty("offset");

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(51);
    });
  });

  it("sets hasMoreMessages to false when fewer messages returned", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [makeMessage({ id: "msg-001", sessionId: "session-001", role: "user", content: "Recent" })] });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.hasMoreMessages).toBe(false);
    });
  });

  it("filters sessions by search query", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        makeSession({ id: "session-001", agentId: "agent-001", title: "Frontend work" }),
        makeSession({ id: "session-002", agentId: "agent-002", title: "Backend API" }),
        makeSession({ id: "session-003", agentId: "agent-003", title: "Frontend design" }),
      ],
    });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(3);
    });

    act(() => {
      result.current.setSearchQuery("frontend");
    });

    await waitFor(() => {
      expect(result.current.filteredSessions).toHaveLength(2);
      expect(result.current.filteredSessions.map((s) => s.id)).toContain("session-001");
      expect(result.current.filteredSessions.map((s) => s.id)).toContain("session-003");
    });

    act(() => {
      result.current.setSearchQuery("");
    });

    await waitFor(() => {
      expect(result.current.filteredSessions).toHaveLength(3);
    });
  });

  it("closes stream when switching sessions", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    const session2 = makeSession({ id: "session-002", agentId: "agent-002" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session, session2] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const closeFn = vi.fn();
    mockStreamChatResponse.mockReturnValue({ close: closeFn, isConnected: () => true });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await act(async () => {
      await result.current.sendMessage("Hello!");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    // Switch sessions
    act(() => {
      result.current.selectSession("session-002");
    });

    await waitFor(() => {
      expect(closeFn).toHaveBeenCalled();
      expect(result.current.activeSession?.id).toBe("session-002");
    });
  });

  it("refreshes sessions", async () => {
    mockFetchChatSessions
      .mockResolvedValueOnce({ sessions: [makeSession({ id: "session-001", agentId: "agent-001" })] })
      .mockResolvedValueOnce({ sessions: [makeSession({ id: "session-001", agentId: "agent-001" }), makeSession({ id: "session-002", agentId: "agent-002" })] });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    await act(async () => {
      await result.current.refreshSessions();
    });

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });
  });

  describe("active session persistence", () => {
    beforeEach(() => {
      // Default: no saved session
      mockGetScopedItem.mockReturnValue(null);
    });

    it("restores active session from localStorage when it matches a loaded session", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001" });
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

      // Simulate a saved session in localStorage
      mockGetScopedItem.mockReturnValue("session-001");

      const { result } = renderHook(() => useChat());

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      await waitFor(() => {
        expect(result.current.activeSession?.id).toBe("session-001");
      });

      // Verify messages were loaded
      await waitFor(() => {
        expect(mockFetchChatMessages).toHaveBeenCalledWith("session-001", { limit: 50 }, undefined);
      });
    });

    it("does not auto-select when saved session does not exist in loaded sessions", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });

      // Simulate a saved session that no longer exists
      mockGetScopedItem.mockReturnValue("non-existent-session");

      const { result } = renderHook(() => useChat());

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      // Should not have an active session since the saved one doesn't exist
      await waitFor(() => {
        expect(result.current.activeSession).toBeNull();
      });

      // Messages should not be loaded since no session is selected
      expect(mockFetchChatMessages).not.toHaveBeenCalled();
    });

    it("persists session ID to localStorage when selecting a session", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001" });
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(mockSetScopedItem).toHaveBeenCalledWith(
          "kb-chat-active-session",
          "session-001",
          "proj-123",
        );
      });
    });

    it("removes session ID from localStorage when deselecting", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001" });
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      // First select a session
      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(result.current.activeSession?.id).toBe("session-001");
      });

      // Reset the mock to track the removal call
      mockSetScopedItem.mockClear();

      // Now deselect
      act(() => {
        result.current.selectSession("");
      });

      await waitFor(() => {
        expect(result.current.activeSession).toBeNull();
      });

      await waitFor(() => {
        expect(mockRemoveScopedItem).toHaveBeenCalledWith(
          "kb-chat-active-session",
          "proj-123",
        );
      });
    });

    it("uses undefined projectId when not provided", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001" });
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useChat());

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(mockSetScopedItem).toHaveBeenCalledWith(
          "kb-chat-active-session",
          "session-001",
          undefined,
        );
      });
    });
  });
});

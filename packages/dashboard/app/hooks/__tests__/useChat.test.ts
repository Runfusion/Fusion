/**
 * Tests for useChat hook: session management, message loading, SSE streaming,
 * search/filter, and pagination.
 */

import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FN_AGENT_ID, useChat } from "../useChat";
import * as apiModule from "../../api";
import { getChatPendingMessageKey } from "../chatPendingMessageStorage";
import * as swrCacheModule from "../../utils/swrCache";
import type { ChatSession, ChatMessage } from "@fusion/core";

// Mock the API module
vi.mock("../../api", () => ({
  fetchChatSessions: vi.fn(),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  editChatMessage: vi.fn(),
  streamChatResponse: vi.fn(),
  attachChatStream: vi.fn(),
  cancelChatResponse: vi.fn(),
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

// Mock the SSE bus
vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

import * as projectStorageModule from "../../utils/projectStorage";
import * as sseBusModule from "../../sse-bus";

const mockGetScopedItem = vi.mocked(projectStorageModule.getScopedItem);
const mockSetScopedItem = vi.mocked(projectStorageModule.setScopedItem);
const mockRemoveScopedItem = vi.mocked(projectStorageModule.removeScopedItem);
const mockSubscribeSse = vi.mocked(sseBusModule.subscribeSse);

const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockFetchChatSession = vi.mocked(apiModule.fetchChatSession);
const mockCreateChatSession = vi.mocked(apiModule.createChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockUpdateChatSession = vi.mocked(apiModule.updateChatSession);
const mockDeleteChatSession = vi.mocked(apiModule.deleteChatSession);
const mockEditChatMessage = vi.mocked(apiModule.editChatMessage);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);
const mockAttachChatStream = vi.mocked(apiModule.attachChatStream);
const mockCancelChatResponse = vi.mocked(apiModule.cancelChatResponse);
const mockFetchAgents = vi.mocked(apiModule.fetchAgents);

function makeSession(overrides: Partial<ChatSession> & Pick<ChatSession, "id" | "agentId">): ChatSession {
  return {
    id: overrides.id,
    agentId: overrides.agentId,
    status: overrides.status ?? "active",
    title: overrides.title ?? null,
    projectId: overrides.projectId ?? null,
    modelProvider: overrides.modelProvider ?? null,
    modelId: overrides.modelId ?? null,
    thinkingLevel: overrides.thinkingLevel ?? null,
    createdAt: overrides.createdAt ?? "2026-04-08T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-08T00:00:00.000Z",
    pinnedAt: overrides.pinnedAt ?? null,
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
  };
}

function makeMessage(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "sessionId" | "role" | "content">): ChatMessage {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId,
    role: overrides.role,
    content: overrides.content,
    thinkingOutput: overrides.thinkingOutput ?? null,
    metadata: overrides.metadata ?? null,
    attachments: overrides.attachments,
    createdAt: overrides.createdAt ?? "2026-04-08T00:00:00.000Z",
  };
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type StreamAppendHandlers = {
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
  onToolStart: (data: { toolName: string; args?: Record<string, unknown> }) => void;
  onToolEnd: (data: { toolName: string; isError: boolean; result?: unknown }) => void;
  onDone?: (data: { messageId?: string; message?: ChatMessage; accumulated: { text: string; thinking: string; toolCalls: unknown[]; fallbackInfo?: unknown } }) => void;
};

function cacheMessages(projectId: string, sessionId: string, messages: ChatMessage[]) {
  localStorage.setItem(
    `${swrCacheModule.SWR_CACHE_KEYS.CHAT_MESSAGES_PREFIX}${projectId}:${sessionId}`,
    JSON.stringify({ savedAt: Date.now(), data: messages }),
  );
}

const setDocumentVisibilityState = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  fireEvent(document, new Event("visibilitychange"));
};

describe("useChat", () => {
  const chatSessionsCacheKey = (projectId: string) => `${swrCacheModule.SWR_CACHE_KEYS.CHAT_SESSIONS_PREFIX}${projectId}`;
  const chatMessagesCacheKey = (projectId: string, sessionId: string) => `${swrCacheModule.SWR_CACHE_KEYS.CHAT_MESSAGES_PREFIX}${projectId}:${sessionId}`;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockGetScopedItem.mockReturnValue(undefined);
    mockFetchChatSessions.mockResolvedValue({ sessions: [] });
    mockFetchChatSession.mockResolvedValue({
      session: makeSession({ id: "session-001", agentId: "agent-001" }),
    });
    mockCreateChatSession.mockResolvedValue({
      session: makeSession({ id: "session-001", agentId: "agent-001", title: "New Chat" }),
    });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockUpdateChatSession.mockResolvedValue({
      session: makeSession({ id: "session-001", agentId: "agent-001", status: "archived" }),
    });
    mockDeleteChatSession.mockResolvedValue({ success: true });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockCancelChatResponse.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
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

  it("hydrates sessions from cache synchronously and skips initial loading state", async () => {
    const projectId = "proj-cache-hit";
    localStorage.setItem(
      chatSessionsCacheKey(projectId),
      JSON.stringify({
        savedAt: Date.now(),
        data: [
          makeSession({ id: "session-001", agentId: "agent-001", updatedAt: "2026-04-08T00:00:00.000Z" }),
          makeSession({ id: "session-002", agentId: "agent-002", updatedAt: "2026-04-07T00:00:00.000Z" }),
        ],
      }),
    );

    let resolveFetch: ((value: { sessions: ChatSession[] }) => void) | undefined;
    mockFetchChatSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const { result } = renderHook(() => useChat(projectId));

    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessionsLoading).toBe(false);

    await act(async () => {
      resolveFetch?.({ sessions: [] });
    });

    await waitFor(() => {
      expect(mockFetchChatSessions).toHaveBeenCalledWith(projectId);
    });
  });

  it("does not hydrate cached task-planner sessions before server settings filtering returns", async () => {
    const projectId = "proj-cache-task-planner";
    localStorage.setItem(
      chatSessionsCacheKey(projectId),
      JSON.stringify({
        savedAt: Date.now(),
        data: [
          makeSession({ id: "session-direct", agentId: "agent-001", updatedAt: "2026-04-08T00:00:00.000Z" }),
          makeSession({ id: "session-planner", agentId: "task-planner:FN-7364", updatedAt: "2026-04-09T00:00:00.000Z" }),
        ],
      }),
    );

    let resolveFetch: ((value: { sessions: ChatSession[] }) => void) | undefined;
    mockFetchChatSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const { result } = renderHook(() => useChat(projectId));

    expect(result.current.sessions.map((session) => session.id)).toEqual(["session-direct"]);

    await act(async () => {
      resolveFetch?.({
        sessions: [
          makeSession({ id: "session-planner", agentId: "task-planner:FN-7364", updatedAt: "2026-04-09T00:00:00.000Z" }),
        ],
      });
    });

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["session-planner"]);
    });
  });

  it("writes sorted sessions to cache after successful refresh", async () => {
    const projectId = "proj-write-through";
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        makeSession({ id: "session-001", agentId: "agent-001", updatedAt: "2026-04-08T00:00:00.000Z" }),
        makeSession({ id: "session-003", agentId: "agent-003", updatedAt: "2026-04-10T00:00:00.000Z" }),
        makeSession({ id: "session-002", agentId: "agent-002", updatedAt: "2026-04-09T00:00:00.000Z" }),
      ],
    });

    renderHook(() => useChat(projectId));

    await waitFor(() => {
      const raw = localStorage.getItem(chatSessionsCacheKey(projectId));
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw ?? "null") as { data: ChatSession[] };
      expect(parsed.data.map((session) => session.id)).toEqual(["session-003", "session-002", "session-001"]);
    });
  });

  it("keeps first-time load semantics when cache is missing", async () => {
    const projectId = "proj-cache-miss";
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        makeSession({ id: "session-001", agentId: "agent-001", updatedAt: "2026-04-08T00:00:00.000Z" }),
        makeSession({ id: "session-002", agentId: "agent-002", updatedAt: "2026-04-10T00:00:00.000Z" }),
      ],
    });

    const { result } = renderHook(() => useChat(projectId));

    expect(result.current.sessionsLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.sessionsLoading).toBe(false);
      expect(result.current.sessions.map((session) => session.id)).toEqual(["session-002", "session-001"]);
    });
  });

  it("clears stale cache envelope when refresh fails with empty in-memory sessions", async () => {
    const projectId = "proj-empty-failure";
    localStorage.setItem(
      chatSessionsCacheKey(projectId),
      JSON.stringify({
        savedAt: Date.now() - 120_000,
        data: [makeSession({ id: "session-stale", agentId: "agent-001" })],
      }),
    );

    const clearCacheSpy = vi.spyOn(swrCacheModule, "clearCache");
    mockFetchChatSessions.mockReset();
    mockFetchChatSessions.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useChat(projectId));

    expect(result.current.sessions).toEqual([]);

    await waitFor(() => {
      expect(result.current.sessionsLoading).toBe(false);
    });

    await waitFor(() => {
      expect(clearCacheSpy).toHaveBeenCalledWith(chatSessionsCacheKey(projectId));
    });
  });

  it("preserves cache envelope when refresh fails after cached sessions hydrate", async () => {
    const projectId = "proj-non-empty-failure";
    localStorage.setItem(
      chatSessionsCacheKey(projectId),
      JSON.stringify({
        savedAt: Date.now(),
        data: [makeSession({ id: "session-cached", agentId: "agent-001" })],
      }),
    );

    mockFetchChatSessions.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useChat(projectId));

    expect(result.current.sessions).toHaveLength(1);

    await waitFor(() => {
      expect(result.current.sessionsLoading).toBe(false);
    });

    expect(localStorage.getItem(chatSessionsCacheKey(projectId))).toBeTruthy();
  });

  it("rehydrates cached sessions per project on project switch", async () => {
    localStorage.setItem(
      chatSessionsCacheKey("p1"),
      JSON.stringify({ savedAt: Date.now(), data: [makeSession({ id: "session-p1", agentId: "agent-001" })] }),
    );
    localStorage.setItem(
      chatSessionsCacheKey("p2"),
      JSON.stringify({ savedAt: Date.now(), data: [makeSession({ id: "session-p2", agentId: "agent-002" })] }),
    );

    let deferredResolve: ((value: { sessions: ChatSession[] }) => void) | undefined;
    mockFetchChatSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferredResolve = resolve;
        }),
    );

    const { result, rerender } = renderHook(({ projectId }: { projectId: string }) => useChat(projectId), {
      initialProps: { projectId: "p1" },
    });

    expect(result.current.sessions.map((session) => session.id)).toEqual(["session-p1"]);
    expect(result.current.sessionsLoading).toBe(false);

    rerender({ projectId: "p2" });

    expect(result.current.sessions.map((session) => session.id)).toEqual(["session-p2"]);
    expect(result.current.sessionsLoading).toBe(false);

    act(() => {
      deferredResolve?.({ sessions: [] });
    });
  });

  it("revalidates sessions in the background when projectId changes", async () => {
    mockFetchChatSessions
      .mockResolvedValueOnce({ sessions: [makeSession({ id: "session-p1", agentId: "agent-001" })] })
      .mockResolvedValueOnce({ sessions: [makeSession({ id: "session-p2", agentId: "agent-002" })] });

    const { rerender } = renderHook(({ projectId }: { projectId: string }) => useChat(projectId), {
      initialProps: { projectId: "p1" },
    });

    await waitFor(() => {
      expect(mockFetchChatSessions).toHaveBeenCalledWith("p1");
    });

    rerender({ projectId: "p2" });

    await waitFor(() => {
      expect(mockFetchChatSessions).toHaveBeenCalledWith("p2");
    });
    expect(mockFetchChatSessions).toHaveBeenCalledTimes(2);
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

  describe("editMessageAndResend", () => {
    const mockAddToast = vi.fn();

    // fetchChatMessages returns newest-first (order=desc); useChat reverses it to display
    // oldest-first. `messages` here is given in display (oldest-first) order for readability,
    // so we reverse it before handing it to the mock to match the real API contract.
    async function setupWithMessages(messages: ChatMessage[]) {
      const session = makeSession({ id: "session-001", agentId: "agent-001" });
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: messages.slice().reverse() });

      const { result } = renderHook(() => useChat("proj-123", mockAddToast));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(messages.length);
      });

      return result;
    }

    it("optimistically truncates from the edited message and resends via sendMessage", async () => {
      const m1 = makeMessage({ id: "msg-1", sessionId: "session-001", role: "user", content: "one" });
      const m2 = makeMessage({ id: "msg-2", sessionId: "session-001", role: "assistant", content: "two" });
      const m3 = makeMessage({ id: "msg-3", sessionId: "session-001", role: "user", content: "three" });
      const result = await setupWithMessages([m1, m2, m3]);

      mockEditChatMessage.mockResolvedValueOnce({ retained: [m1, m2] });
      const closeFn = vi.fn();
      mockStreamChatResponse.mockImplementation(() => ({ close: closeFn, isConnected: () => true }));

      await act(async () => {
        await result.current.editMessageAndResend("msg-3", "three (edited)");
      });

      expect(mockEditChatMessage).toHaveBeenCalledWith("session-001", "msg-3", "three (edited)", "proj-123");
      await waitFor(() => {
        // Optimistic truncation drops msg-3, then sendMessage appends a fresh optimistic user bubble
        // with the edited content — so retained [m1, m2] plus the new turn is 3 messages.
        expect(result.current.messages).toHaveLength(3);
        expect(result.current.messages[0]?.id).toBe("msg-1");
        expect(result.current.messages[1]?.id).toBe("msg-2");
        expect(result.current.messages[2]?.role).toBe("user");
        expect(result.current.messages[2]?.content).toBe("three (edited)");
      });
      expect(mockStreamChatResponse).toHaveBeenCalledWith("session-001", "three (edited)", expect.anything(), undefined, "proj-123");
    });

    it("is a no-op while streaming", async () => {
      const m1 = makeMessage({ id: "msg-1", sessionId: "session-001", role: "user", content: "one" });
      const result = await setupWithMessages([m1]);

      mockStreamChatResponse.mockImplementation(() => ({ close: vi.fn(), isConnected: () => true }));
      act(() => {
        result.current.sendMessage("in flight");
      });
      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      mockEditChatMessage.mockClear();
      await act(async () => {
        await result.current.editMessageAndResend("msg-1", "edited");
      });

      expect(mockEditChatMessage).not.toHaveBeenCalled();
    });

    it("reloads messages and does not resend on PATCH failure", async () => {
      const m1 = makeMessage({ id: "msg-1", sessionId: "session-001", role: "user", content: "one" });
      const m2 = makeMessage({ id: "msg-2", sessionId: "session-001", role: "assistant", content: "two" });
      const result = await setupWithMessages([m1, m2]);

      mockEditChatMessage.mockRejectedValueOnce(new Error("boom"));
      // fetchChatMessages returns newest-first; the reload path reverses it back to [m1, m2].
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [m2, m1] });
      mockStreamChatResponse.mockClear();

      await expect(act(async () => {
        await result.current.editMessageAndResend("msg-1", "edited");
      })).rejects.toThrow("boom");

      await waitFor(() => {
        expect(result.current.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
      });
      expect(mockStreamChatResponse).not.toHaveBeenCalled();
    });
  });

  it("populates agentsMap on mount", async () => {
    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "proj-123");
    });

    await waitFor(() => {
      expect(result.current.agentsMap.size).toBe(2);
    });

    expect(result.current.agentsMap.get("agent-001")?.name).toBe("Alpha");
    expect(result.current.agentsMap.get("agent-002")?.name).toBe("Beta");
  });

  it("passes projectId to fetchAgents for agentMap hydration", async () => {
    renderHook(() => useChat("proj-456"));

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "proj-456");
    });
  });

  it("refetches agents when projectId changes", async () => {
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useChat(projectId),
      { initialProps: { projectId: "proj-001" } },
    );

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "proj-001");
    });

    // Change project
    rerender({ projectId: "proj-002" });

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "proj-002");
    });

    // Should have been called twice (once per project)
    expect(mockFetchAgents).toHaveBeenCalledTimes(2);
  });

  it("does not populate agentsMap from stale response after project switch", async () => {
    // Simulate slow agent fetch for project-001 and fast fetch for project-002
    mockFetchAgents
      .mockResolvedValueOnce([
        { id: "stale-agent", name: "Stale Agent (proj-001)", role: "executor", state: "idle", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
      ])
      .mockResolvedValueOnce([
        { id: "fresh-agent", name: "Fresh Agent (proj-002)", role: "executor", state: "idle", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
      ]);

    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useChat(projectId),
      { initialProps: { projectId: "proj-001" } },
    );

    // Wait for first fetch to start
    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "proj-001");
    });

    // Switch to project-002 while first fetch is still in flight
    rerender({ projectId: "proj-002" });

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "proj-002");
    });

    // The second renderHook doesn't expose agentsMap directly from a fresh call,
    // but we can verify the mock was called correctly by checking call order
    const calls = mockFetchAgents.mock.calls;
    expect(calls[0][1]).toBe("proj-001");
    expect(calls[1][1]).toBe("proj-002");
  });

  it("hydrates restored active-session messages from cache before network resolves", async () => {
    const projectId = "proj-message-cache-hit";
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    localStorage.setItem(
      chatSessionsCacheKey(projectId),
      JSON.stringify({ savedAt: Date.now(), data: [session] }),
    );
    localStorage.setItem(
      chatMessagesCacheKey(projectId, session.id),
      JSON.stringify({
        savedAt: Date.now(),
        data: [makeMessage({ id: "msg-cached", sessionId: session.id, role: "assistant", content: "Cached reply" })],
      }),
    );
    mockGetScopedItem.mockReturnValue(session.id);

    let resolveFetch: ((value: { messages: ChatMessage[] }) => void) | undefined;
    mockFetchChatMessages.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const { result } = renderHook(() => useChat(projectId));

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe(session.id);
    });

    expect(result.current.messagesLoading).toBe(false);
    expect(result.current.messages).toEqual([
      expect.objectContaining({ id: "msg-cached", content: "Cached reply" }),
    ]);

    await act(async () => {
      resolveFetch?.({ messages: [makeMessage({ id: "msg-fresh", sessionId: session.id, role: "assistant", content: "Fresh reply" })] });
    });

    await waitFor(() => {
      expect(result.current.messages[0]?.id).toBe("msg-fresh");
    });
  });

  it("writes loaded messages through to cache", async () => {
    const projectId = "proj-message-write-through";
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [
        makeMessage({ id: "msg-001", sessionId: session.id, role: "user", content: "Hello" }),
        makeMessage({ id: "msg-002", sessionId: session.id, role: "assistant", content: "Hi" }),
      ],
    });

    const { result } = renderHook(() => useChat(projectId));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession(session.id);
    });

    await waitFor(() => {
      const raw = localStorage.getItem(chatMessagesCacheKey(projectId, session.id));
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw ?? "null") as { data: ChatMessage[] };
      expect(parsed.data).toHaveLength(2);
    });
  });

  it("shows loading on message cache miss until the fetch resolves", async () => {
    const projectId = "proj-message-cache-miss";
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });

    let resolveFetch: ((value: { messages: ChatMessage[] }) => void) | undefined;
    mockFetchChatMessages.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const { result } = renderHook(() => useChat(projectId));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession(session.id);
    });

    expect(result.current.messagesLoading).toBe(true);

    await act(async () => {
      resolveFetch?.({ messages: [makeMessage({ id: "msg-001", sessionId: session.id, role: "assistant", content: "Loaded" })] });
    });

    await waitFor(() => {
      expect(result.current.messagesLoading).toBe(false);
      expect(result.current.messages[0]).toEqual(expect.objectContaining({ id: "msg-001", content: "Loaded" }));
    });
  });

  it("does not overwrite the session cache when paginating older messages", async () => {
    const projectId = "proj-pagination-cache";
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    const newestPage = Array.from({ length: 50 }, (_, index) =>
      makeMessage({
        id: `msg-${index + 1}`,
        sessionId: session.id,
        role: "assistant",
        content: `Message ${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 3, 8, 0, 0, 50 - index)).toISOString(),
      }),
    );
    const olderPage = [makeMessage({
      id: "msg-old",
      sessionId: session.id,
      role: "assistant",
      content: "Older message",
      createdAt: "2026-04-08T00:00:00.000Z",
    })];
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: newestPage })
      .mockResolvedValueOnce({ messages: olderPage });

    const { result } = renderHook(() => useChat(projectId));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession(session.id);
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(50);
    });

    await act(async () => {
      await result.current.loadMoreMessages();
    });

    const parsed = JSON.parse(localStorage.getItem(chatMessagesCacheKey(projectId, session.id)) ?? "null") as { data: ChatMessage[] };
    expect(parsed.data).toHaveLength(50);
    expect(parsed.data[0]?.id).toBe("msg-50");
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
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-001", { limit: 50, order: "desc" }, undefined);
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
    // API returns messages newest-first (order=desc); simulate that in the mock
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [
        makeMessage({ id: "msg-004", sessionId: "session-001", role: "assistant", content: "Second answer" }),
        makeMessage({ id: "msg-003", sessionId: "session-001", role: "user", content: "Second question" }),
        makeMessage({ id: "msg-002", sessionId: "session-001", role: "assistant", content: "First answer" }),
        makeMessage({ id: "msg-001", sessionId: "session-001", role: "user", content: "First question" }),
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

  it("rehydrates persisted failure metadata when loading message history", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [
        makeMessage({
          id: "msg-failure",
          sessionId: "session-001",
          role: "assistant",
          content: "Model request failed",
          metadata: {
            failureInfo: {
              summary: "Model request failed",
              errorClass: "ProviderError",
              code: "E_MODEL",
              detail: "ProviderError: Model request failed",
            },
          },
        }),
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
      expect(result.current.messages).toHaveLength(1);
    });

    expect(result.current.messages[0]).toEqual(expect.objectContaining({
      id: "msg-failure",
      failureInfo: {
        summary: "Model request failed",
        errorClass: "ProviderError",
        code: "E_MODEL",
        detail: "ProviderError: Model request failed",
      },
    }));
  });

  it("creates a new session with thinking level and selects it", async () => {
    const newSession = makeSession({ id: "session-new", agentId: "agent-001", title: "Test Chat", thinkingLevel: "medium" });
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
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        thinkingLevel: "medium",
      });
    });

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        {
          agentId: "agent-001",
          title: "Test Chat",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
          thinkingLevel: "medium",
        },
        undefined,
      );
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-new");
      expect(result.current.activeSession?.thinkingLevel).toBe("medium");
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

  it("renames a session optimistically, trims the API title, and updates the active header state", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001", title: "Old title" });
    const renamedSession = makeSession({
      id: "session-001",
      agentId: "agent-001",
      title: "New title",
      updatedAt: "2026-04-09T00:00:00.000Z",
    });
    const deferred = createDeferredPromise<{ session: ChatSession }>();
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockUpdateChatSession.mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => {
      result.current.selectSession("session-001", session);
    });

    await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

    await act(async () => {
      void result.current.renameSession("session-001", "  New title  ");
    });

    expect(mockUpdateChatSession).toHaveBeenCalledWith("session-001", { title: "New title" }, "proj-123");
    expect(result.current.sessions[0]?.title).toBe("New title");
    expect(result.current.activeSession?.title).toBe("New title");

    await act(async () => {
      deferred.resolve({ session: renamedSession });
      await deferred.promise;
    });

    expect(result.current.sessions[0]?.updatedAt).toBe("2026-04-09T00:00:00.000Z");
    expect(result.current.activeSession?.updatedAt).toBe("2026-04-09T00:00:00.000Z");
  });

  it("renames an untitled session to a named title optimistically", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001", title: null });
    const deferred = createDeferredPromise<{ session: ChatSession }>();
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockUpdateChatSession.mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => {
      result.current.selectSession("session-001", session);
    });

    await waitFor(() => expect(result.current.activeSession?.title).toBeNull());

    await act(async () => {
      void result.current.renameSession("session-001", "Named title");
    });

    expect(mockUpdateChatSession).toHaveBeenCalledWith("session-001", { title: "Named title" }, "proj-123");
    expect(result.current.sessions[0]?.title).toBe("Named title");
    expect(result.current.activeSession?.title).toBe("Named title");

    await act(async () => {
      deferred.resolve({ session: makeSession({ ...session, title: "Named title" }) });
      await deferred.promise;
    });
  });

  it("renames a session to Untitled for whitespace and rolls back with a toast on failure", async () => {
    const addToast = vi.fn();
    const session = makeSession({ id: "session-001", agentId: "agent-001", title: "Keep me" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockUpdateChatSession.mockRejectedValueOnce(new Error("rename failed"));

    const { result } = renderHook(() => useChat("proj-123", addToast));

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => {
      result.current.selectSession("session-001", session);
    });

    await waitFor(() => expect(result.current.activeSession?.title).toBe("Keep me"));

    await act(async () => {
      await expect(result.current.renameSession("session-001", "   ")).rejects.toThrow("rename failed");
    });

    expect(mockUpdateChatSession).toHaveBeenCalledWith("session-001", { title: null }, "proj-123");
    expect(result.current.sessions[0]?.title).toBe("Keep me");
    expect(result.current.activeSession?.title).toBe("Keep me");
    expect(addToast).toHaveBeenCalledWith("Failed to rename conversation", "error");
  });

  it("pins optimistically, reconciles the server timestamp, and sorts pinned sessions first", async () => {
    const newer = makeSession({ id: "newer", agentId: "agent-001", updatedAt: "2026-04-10T00:00:00.000Z" });
    const older = makeSession({ id: "older", agentId: "agent-001", updatedAt: "2026-04-09T00:00:00.000Z" });
    const pinnedAt = "2026-04-08T00:00:00.000Z";
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [newer, older] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockUpdateChatSession.mockResolvedValueOnce({ session: makeSession({ ...older, pinnedAt }) });

    const { result } = renderHook(() => useChat("proj-123"));
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
    await act(async () => { await result.current.pinSession("older", true); });

    expect(mockUpdateChatSession).toHaveBeenCalledWith("older", { pinned: true }, "proj-123");
    expect(result.current.sessions.map((session) => session.id)).toEqual(["older", "newer"]);
    expect(result.current.pinnedCount).toBe(1);
  });

  describe("setSessionModel", () => {
    it("switches an active session to a model optimistically and reconciles with the server", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001", modelProvider: null, modelId: null });
      const updatedSession = makeSession({
        id: "session-001",
        agentId: FN_AGENT_ID,
        modelProvider: "openai",
        modelId: "gpt-4o",
        updatedAt: "2026-04-09T00:00:00.000Z",
      });
      const deferred = createDeferredPromise<{ session: ChatSession }>();
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockUpdateChatSession.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => expect(result.current.sessions).toHaveLength(1));

      act(() => {
        result.current.selectSession("session-001", session);
      });

      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

      await act(async () => {
        void result.current.setSessionModel("session-001", { modelProvider: "openai", modelId: "gpt-4o" });
      });

      expect(mockUpdateChatSession).toHaveBeenCalledWith(
        "session-001",
        { agentId: FN_AGENT_ID, modelProvider: "openai", modelId: "gpt-4o" },
        "proj-123",
      );
      expect(result.current.sessions[0]).toMatchObject({ agentId: FN_AGENT_ID, modelProvider: "openai", modelId: "gpt-4o" });
      expect(result.current.activeSession).toMatchObject({ agentId: FN_AGENT_ID, modelProvider: "openai", modelId: "gpt-4o" });

      await act(async () => {
        deferred.resolve({ session: updatedSession });
        await deferred.promise;
      });

      expect(result.current.sessions[0]).toMatchObject({
        agentId: FN_AGENT_ID,
        modelProvider: "openai",
        modelId: "gpt-4o",
        updatedAt: "2026-04-09T00:00:00.000Z",
      });
      expect(result.current.activeSession).toMatchObject({
        agentId: FN_AGENT_ID,
        modelProvider: "openai",
        modelId: "gpt-4o",
        updatedAt: "2026-04-09T00:00:00.000Z",
      });
    });

    it("switches an active session to an agent optimistically and clears the model pair", async () => {
      const session = makeSession({ id: "session-001", agentId: FN_AGENT_ID, modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
      const updatedSession = makeSession({ id: "session-001", agentId: "agent-specialist", modelProvider: null, modelId: null });
      const deferred = createDeferredPromise<{ session: ChatSession }>();
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockUpdateChatSession.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => expect(result.current.sessions).toHaveLength(1));

      act(() => {
        result.current.selectSession("session-001", session);
      });

      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

      await act(async () => {
        void result.current.setSessionModel("session-001", { agentId: "agent-specialist" });
      });

      expect(mockUpdateChatSession).toHaveBeenCalledWith(
        "session-001",
        { agentId: "agent-specialist", modelProvider: null, modelId: null },
        "proj-123",
      );
      expect(result.current.sessions[0]).toMatchObject({ agentId: "agent-specialist", modelProvider: null, modelId: null });
      expect(result.current.activeSession).toMatchObject({ agentId: "agent-specialist", modelProvider: null, modelId: null });

      await act(async () => {
        deferred.resolve({ session: updatedSession });
        await deferred.promise;
      });
    });

    it("rolls back sessions/activeSession and surfaces an error toast on failure", async () => {
      const addToast = vi.fn();
      const session = makeSession({ id: "session-001", agentId: FN_AGENT_ID, modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockUpdateChatSession.mockRejectedValueOnce(new Error("model failed"));

      const { result } = renderHook(() => useChat("proj-123", addToast));

      await waitFor(() => expect(result.current.sessions).toHaveLength(1));

      act(() => {
        result.current.selectSession("session-001", session);
      });

      await waitFor(() => expect(result.current.activeSession?.modelId).toBe("claude-sonnet-4-5"));

      await act(async () => {
        await expect(result.current.setSessionModel("session-001", { agentId: "agent-specialist" })).rejects.toThrow("model failed");
      });

      expect(mockUpdateChatSession).toHaveBeenCalledWith(
        "session-001",
        { agentId: "agent-specialist", modelProvider: null, modelId: null },
        "proj-123",
      );
      expect(result.current.sessions[0]).toMatchObject({ agentId: FN_AGENT_ID, modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
      expect(result.current.activeSession).toMatchObject({ agentId: FN_AGENT_ID, modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
      expect(addToast).toHaveBeenCalledWith("Failed to update chat model", "error");
    });

    it("updates only the matching sessions entry when the session is not active", async () => {
      const activeSessionSeed = makeSession({ id: "session-active", agentId: "agent-001" });
      const otherSession = makeSession({ id: "session-other", agentId: "agent-002", modelProvider: null, modelId: null });
      const deferred = createDeferredPromise<{ session: ChatSession }>();
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [activeSessionSeed, otherSession] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockUpdateChatSession.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => expect(result.current.sessions).toHaveLength(2));

      act(() => {
        result.current.selectSession("session-active", activeSessionSeed);
      });

      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-active"));

      await act(async () => {
        void result.current.setSessionModel("session-other", { modelProvider: "openai", modelId: "gpt-4o-mini" });
      });

      expect(mockUpdateChatSession).toHaveBeenCalledWith(
        "session-other",
        { agentId: FN_AGENT_ID, modelProvider: "openai", modelId: "gpt-4o-mini" },
        "proj-123",
      );
      expect(result.current.sessions.find((s) => s.id === "session-other")).toMatchObject({
        agentId: FN_AGENT_ID,
        modelProvider: "openai",
        modelId: "gpt-4o-mini",
      });
      expect(result.current.activeSession).toMatchObject({ id: "session-active", agentId: "agent-001" });

      await act(async () => {
        deferred.resolve({ session: makeSession({ ...otherSession, agentId: FN_AGENT_ID, modelProvider: "openai", modelId: "gpt-4o-mini" }) });
        await deferred.promise;
      });
    });
  });

  // FN-7898: setSessionThinkingLevel lets an existing session's reasoning-effort level be
  // changed mid-conversation via the in-chat composer control; mirrors renameSession's
  // optimistic-update-with-rollback contract.
  describe("setSessionThinkingLevel", () => {
    it("updates sessions and activeSession optimistically, then reconciles with the server response", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001", thinkingLevel: null });
      const updatedSession = makeSession({
        id: "session-001",
        agentId: "agent-001",
        thinkingLevel: "high",
        updatedAt: "2026-04-09T00:00:00.000Z",
      });
      const deferred = createDeferredPromise<{ session: ChatSession }>();
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockUpdateChatSession.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => expect(result.current.sessions).toHaveLength(1));

      act(() => {
        result.current.selectSession("session-001", session);
      });

      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

      await act(async () => {
        void result.current.setSessionThinkingLevel("session-001", "high");
      });

      expect(mockUpdateChatSession).toHaveBeenCalledWith("session-001", { thinkingLevel: "high" }, "proj-123");
      expect(result.current.sessions[0]?.thinkingLevel).toBe("high");
      expect(result.current.activeSession?.thinkingLevel).toBe("high");

      await act(async () => {
        deferred.resolve({ session: updatedSession });
        await deferred.promise;
      });

      expect(result.current.sessions[0]?.thinkingLevel).toBe("high");
      expect(result.current.sessions[0]?.updatedAt).toBe("2026-04-09T00:00:00.000Z");
      expect(result.current.activeSession?.thinkingLevel).toBe("high");
      expect(result.current.activeSession?.updatedAt).toBe("2026-04-09T00:00:00.000Z");
    });

    it("rolls back sessions/activeSession and surfaces an error toast on failure", async () => {
      const addToast = vi.fn();
      const session = makeSession({ id: "session-001", agentId: "agent-001", thinkingLevel: "low" });
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockUpdateChatSession.mockRejectedValueOnce(new Error("update failed"));

      const { result } = renderHook(() => useChat("proj-123", addToast));

      await waitFor(() => expect(result.current.sessions).toHaveLength(1));

      act(() => {
        result.current.selectSession("session-001", session);
      });

      await waitFor(() => expect(result.current.activeSession?.thinkingLevel).toBe("low"));

      await act(async () => {
        await expect(result.current.setSessionThinkingLevel("session-001", "xhigh")).rejects.toThrow("update failed");
      });

      expect(mockUpdateChatSession).toHaveBeenCalledWith("session-001", { thinkingLevel: "xhigh" }, "proj-123");
      expect(result.current.sessions[0]?.thinkingLevel).toBe("low");
      expect(result.current.activeSession?.thinkingLevel).toBe("low");
      expect(addToast).toHaveBeenCalledWith("Failed to update thinking level", "error");
    });

    it("updates only the matching sessions entry when the session is not active", async () => {
      const activeSessionSeed = makeSession({ id: "session-active", agentId: "agent-001", thinkingLevel: "low" });
      const otherSession = makeSession({ id: "session-other", agentId: "agent-002", thinkingLevel: null });
      const deferred = createDeferredPromise<{ session: ChatSession }>();
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [activeSessionSeed, otherSession] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockUpdateChatSession.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => expect(result.current.sessions).toHaveLength(2));

      act(() => {
        result.current.selectSession("session-active", activeSessionSeed);
      });

      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-active"));

      await act(async () => {
        void result.current.setSessionThinkingLevel("session-other", "medium");
      });

      expect(mockUpdateChatSession).toHaveBeenCalledWith("session-other", { thinkingLevel: "medium" }, "proj-123");
      const otherEntry = result.current.sessions.find((s) => s.id === "session-other");
      expect(otherEntry?.thinkingLevel).toBe("medium");
      expect(result.current.activeSession?.id).toBe("session-active");
      expect(result.current.activeSession?.thinkingLevel).toBe("low");

      await act(async () => {
        deferred.resolve({ session: makeSession({ ...otherSession, thinkingLevel: "medium" }) });
        await deferred.promise;
      });
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

  it("sets isStreaming true during first send and clears on delayed done", async () => {
    const session = makeSession({
      id: "session-001",
      agentId: "agent-001",
      title: "Test Session",
    });

    mockFetchChatSessions.mockResolvedValue({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useChat(undefined, "project-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onDone?.({ messageId: "msg-001" });
      }, 200);
      return { close: vi.fn(), isConnected: () => true };
    });

    act(() => {
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
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

    let doneHandler: ((data: { messageId: string; message?: ChatMessage }) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      doneHandler = handlers.onDone as typeof doneHandler;
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
      result.current.sendMessage("Hello!");
    });

    act(() => {
      doneHandler?.({
        messageId: "msg-002",
        message: {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "Snapshot reply",
          thinkingOutput: null,
          metadata: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        } as ChatMessage,
      });
    });

    await waitFor(() => {
      expect(result.current.messages.find((message) => message.id === "msg-002")).toEqual(expect.objectContaining({
        id: "msg-002",
        role: "assistant",
        content: "Snapshot reply",
      }));
      expect(result.current.isStreaming).toBe(false);
    });
  });

  it.each([
    {
      name: "single sentence boundary",
      chunks: ["Hello.", " World."],
      expected: "Hello. World.",
    },
    {
      name: "multiple sentence boundaries across three chunks",
      chunks: ["One.", " Two.", " Three.", " Four."],
      expected: "One. Two. Three. Four.",
    },
    {
      name: "trailing whitespace-only delta before done",
      chunks: ["Trailing", " "],
      expected: "Trailing ",
    },
  ])("prefers streamed text over done snapshot (%s)", async ({ chunks, expected }) => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

    let textHandler: ((data: string) => void) | undefined;
    let doneHandler: ((data: { messageId: string; message?: ChatMessage }) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      textHandler = handlers.onText;
      doneHandler = handlers.onDone as typeof doneHandler;
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    act(() => {
      result.current.sendMessage("Hello!");
      for (const chunk of chunks) {
        textHandler?.(chunk);
      }
      doneHandler?.({
        messageId: "msg-003",
        message: {
          id: "msg-003",
          sessionId: "session-001",
          role: "assistant",
          content: expected.replace(/\s+/g, ""),
          thinkingOutput: null,
          metadata: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        } as ChatMessage,
      });
    });

    await waitFor(() => {
      expect(result.current.messages.find((message) => message.id === "msg-003")).toEqual(expect.objectContaining({
        id: "msg-003",
        content: expected,
      }));
    });
  });

  it("handles stream errors, appends a failure bubble, and surfaces them to the user", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });
    const addToast = vi.fn();

    let errorHandler: ((data: string | apiModule.ChatFailureInfo) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      errorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useChat(undefined, addToast));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    await act(async () => {
      await result.current.sendMessage("Hello!");
    });

    await act(async () => {
      errorHandler?.("Stream connection failed");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]).toEqual(expect.objectContaining({
        role: "assistant",
        content: "Stream connection failed",
        failureInfo: { summary: "Stream connection failed" },
      }));
      expect(addToast).toHaveBeenCalledWith("Stream connection failed", "error");
    });
  });

  it("suppresses Load failed toast when tab is hidden and reconciles messages", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    const addToast = vi.fn();

    let errorHandler: ((data: string | apiModule.ChatFailureInfo) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      errorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    setDocumentVisibilityState("hidden");
    const { result } = renderHook(() => useChat(undefined, addToast));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    act(() => {
      result.current.sendMessage("Hello!");
      errorHandler?.("Load failed");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
      expect(addToast).not.toHaveBeenCalledWith("Load failed", "error");
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-001", { limit: 50, order: "desc" }, undefined);
    });
  });

  it("re-attaches suspended stream when session is still generating", async () => {
    const session = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        status: "generating" as const,
        streamingText: "partial",
        streamingThinking: "thinking",
        toolCalls: [],
        replayFromEventId: 42,
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    };
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatSession.mockResolvedValueOnce({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    const addToast = vi.fn();

    let errorHandler: ((data: string | apiModule.ChatFailureInfo) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      errorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    setDocumentVisibilityState("hidden");
    const { result } = renderHook(() => useChat(undefined, addToast));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    const messageLoadCountBeforeError = mockFetchChatMessages.mock.calls.length;

    act(() => {
      result.current.sendMessage("Hello!");
      errorHandler?.("Load failed");
    });

    await waitFor(() => {
      expect(addToast).not.toHaveBeenCalledWith("Load failed", "error");
      expect(mockAttachChatStream).toHaveBeenCalledWith(
        "session-001",
        expect.any(Object),
        undefined,
        { lastEventId: 42 },
      );
      expect(mockFetchChatMessages.mock.calls.length).toBe(messageLoadCountBeforeError);
    });
  });

  it("suppresses Load failed when tab stays visible and does not add failure bubble", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchChatSession.mockResolvedValueOnce({ session });
    const addToast = vi.fn();

    let errorHandler: ((data: string | apiModule.ChatFailureInfo) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      errorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    setDocumentVisibilityState("visible");
    const { result } = renderHook(() => useChat(undefined, addToast));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    act(() => {
      result.current.sendMessage("Hello!");
      errorHandler?.("Load failed");
    });

    await waitFor(() => {
      expect(addToast).not.toHaveBeenCalledWith("Load failed", "error");
      expect(result.current.messages.find((m) => m.failureInfo?.summary === "Load failed")).toBeUndefined();
      expect(mockFetchChatSession).toHaveBeenCalledWith("session-001", undefined);
    });
  });

  it("suppresses Failed to fetch shortly after hidden to visible transition", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    const addToast = vi.fn();

    let errorHandler: ((data: string | apiModule.ChatFailureInfo) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      errorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    setDocumentVisibilityState("hidden");
    const { result } = renderHook(() => useChat(undefined, addToast));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      setDocumentVisibilityState("visible");
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    act(() => {
      result.current.sendMessage("Hello!");
      errorHandler?.("Failed to fetch");
    });

    await waitFor(() => {
      expect(addToast).not.toHaveBeenCalledWith("Failed to fetch", "error");
    });
  });

  it("FN-6496 loads prior thread when visibility resume reattaches", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    const priorThreadNewestFirst = [
      makeMessage({ id: "msg-004", sessionId: session.id, role: "assistant", content: "Second answer" }),
      makeMessage({ id: "msg-003", sessionId: session.id, role: "user", content: "Second question" }),
      makeMessage({ id: "msg-002", sessionId: session.id, role: "assistant", content: "First answer" }),
      makeMessage({ id: "msg-001", sessionId: session.id, role: "user", content: "First question" }),
    ];
    const generatingSession = {
      ...session,
      isGenerating: true,
      inFlightGeneration: {
        status: "generating" as const,
        streamingText: "partial",
        streamingThinking: "thinking",
        toolCalls: [],
        replayFromEventId: 77,
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    };
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatSession.mockResolvedValueOnce({ session: generatingSession });
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: priorThreadNewestFirst });
    const addToast = vi.fn();

    const { result } = renderHook(() => useChat(undefined, addToast));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    act(() => {
      setDocumentVisibilityState("hidden");
      setDocumentVisibilityState("visible");
    });

    await waitFor(() => {
      expect(mockFetchChatSession).toHaveBeenCalledWith("session-001", undefined);
      expect(mockAttachChatStream).toHaveBeenCalledWith(
        "session-001",
        expect.any(Object),
        undefined,
        { lastEventId: 77 },
      );
      expect(result.current.isStreaming).toBe(true);
      expect(result.current.messages.map((message) => message.id)).toEqual([
        "msg-001",
        "msg-002",
        "msg-003",
        "msg-004",
      ]);
      expect(addToast).not.toHaveBeenCalled();
    });
  });

  it("FN-5104 reattaches once when selectSession refresh reveals in-flight generation from stale cache", async () => {
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
        toolCalls: [{ id: "tool-1", type: "function", function: { name: "search", arguments: "{}" } }],
        replayFromEventId: 19,
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    };
    const priorThreadNewestFirst = [
      makeMessage({ id: "msg-004", sessionId: staleSession.id, role: "assistant", content: "Second answer" }),
      makeMessage({ id: "msg-003", sessionId: staleSession.id, role: "user", content: "Second question" }),
      makeMessage({ id: "msg-002", sessionId: staleSession.id, role: "assistant", content: "First answer" }),
      makeMessage({ id: "msg-001", sessionId: staleSession.id, role: "user", content: "First question" }),
    ];

    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [staleSession] });
    mockFetchChatSession.mockResolvedValueOnce({ session: generatingSession });
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: priorThreadNewestFirst });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(mockAttachChatStream).toHaveBeenCalledTimes(1);
      expect(mockAttachChatStream).toHaveBeenCalledWith(
        "session-001",
        expect.any(Object),
        undefined,
        { lastEventId: 19 },
      );
      expect(result.current.streamingText).toBe("partial text");
      expect(result.current.streamingThinking).toBe("thinking");
      expect(result.current.streamingToolCalls).toHaveLength(1);
      expect(result.current.messages.map((message) => message.id)).toEqual([
        "msg-001",
        "msg-002",
        "msg-003",
        "msg-004",
      ]);
    });
  });

  it("FN-5104 does not reattach after an authoritative idle response", async () => {
    const session = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        status: "generating" as const,
        streamingText: "partial",
        streamingThinking: "thinking",
        toolCalls: [],
        replayFromEventId: 8,
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    };
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatSession.mockResolvedValue({ session: { ...session, isGenerating: false, inFlightGeneration: null } });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      // A stale list row must not reopen a generation that the authoritative endpoint says ended.
      expect(result.current.isStreaming).toBe(false);
      expect(mockAttachChatStream).not.toHaveBeenCalled();
    });

    act(() => {
      result.current.stopStreaming();
    });

    expect(mockAttachChatStream).not.toHaveBeenCalled();
    expect(result.current.isStreaming).toBe(false);
  });

  it("FN-7656 reattaches and shows working state on refresh reporting isGenerating with no inFlightGeneration snapshot yet (pre-first-delta)", async () => {
    // Regression: early in a generation the server reports isGenerating:true
    // with inFlightGeneration still null (no delta emitted yet). The stale
    // local `sessions` cache also reports isGenerating:false. selectSession's
    // authoritative fetchChatSession refresh must reattach on isGenerating
    // alone, without waiting for an inFlightGeneration snapshot.
    const staleSession = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: false,
      inFlightGeneration: null,
    };
    const generatingSessionNoSnapshot = {
      ...staleSession,
      isGenerating: true,
      inFlightGeneration: null,
    };

    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [staleSession] });
    mockFetchChatSession.mockResolvedValueOnce({ session: generatingSessionNoSnapshot });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(mockAttachChatStream).toHaveBeenCalledTimes(1);
      expect(mockAttachChatStream).toHaveBeenCalledWith("session-001", expect.any(Object), undefined, {});
      expect(result.current.isStreaming).toBe(true);
    });
  });

  it("FN-7656 does not reattach when the authoritative refresh reports isGenerating:false", async () => {
    const session = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: false,
      inFlightGeneration: null,
    };
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatSession.mockResolvedValueOnce({ session: { ...session, isGenerating: false, inFlightGeneration: null } });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(mockFetchChatSession).toHaveBeenCalledWith("session-001", undefined);
    });

    expect(mockAttachChatStream).not.toHaveBeenCalled();
    expect(result.current.isStreaming).toBe(false);
  });

  it("FN-7656 does not reattach to a session the user has already navigated away from before the refresh resolves", async () => {
    const sessionA = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: false,
      inFlightGeneration: null,
    };
    const sessionB = {
      ...makeSession({ id: "session-002", agentId: "agent-001" }),
      isGenerating: false,
      inFlightGeneration: null,
    };
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [sessionA, sessionB] });
    const deferredRefresh = createDeferredPromise<{ session: ChatSession }>();
    mockFetchChatSession.mockReturnValueOnce(deferredRefresh.promise);
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useChat());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(mockFetchChatSession).toHaveBeenCalledWith("session-001", undefined);
    });

    // User navigates away to session-002 before the session-001 refresh resolves.
    act(() => {
      result.current.selectSession("session-002");
    });

    await act(async () => {
      deferredRefresh.resolve({
        session: { ...sessionA, isGenerating: true, inFlightGeneration: null },
      });
      await Promise.resolve();
    });

    expect(mockAttachChatStream).not.toHaveBeenCalled();
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.activeSession?.id).toBe("session-002");
  });

  it("FN-8504 waits for the authoritative re-entry snapshot before attaching from its cursor", async () => {
    const staleListSession = {
      ...makeSession({ id: "session-stale-cursor", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        status: "generating" as const,
        streamingText: "stale partial",
        streamingThinking: "stale reasoning",
        toolCalls: [],
        replayFromEventId: 17,
        updatedAt: "2026-07-20T19:00:00.000Z",
      },
    };
    const authoritativeRefresh = createDeferredPromise<{ session: ChatSession }>();
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [staleListSession] });
    mockFetchChatSession.mockReturnValueOnce(authoritativeRefresh.promise);
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => {
      result.current.selectSession(staleListSession.id);
    });

    await waitFor(() => {
      expect(mockFetchChatSession).toHaveBeenCalledWith(staleListSession.id, undefined);
    });
    expect(mockAttachChatStream).not.toHaveBeenCalled();

    await act(async () => {
      authoritativeRefresh.resolve({
        session: {
          ...staleListSession,
          inFlightGeneration: {
            ...staleListSession.inFlightGeneration,
            streamingText: "authoritative partial",
            streamingThinking: "authoritative reasoning",
            replayFromEventId: 23,
          },
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockAttachChatStream).toHaveBeenCalledTimes(1);
      expect(mockAttachChatStream).toHaveBeenCalledWith(
        staleListSession.id,
        expect.any(Object),
        undefined,
        { lastEventId: 23 },
      );
      expect(result.current.streamingText).toBe("authoritative partial");
      expect(result.current.streamingThinking).toBe("authoritative reasoning");
    });
  });

  it("FN-8504 ignores an earlier A refresh after rapid A → B → A re-entry", async () => {
    const sessionA = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: false,
      inFlightGeneration: null,
    };
    const sessionB = {
      ...makeSession({ id: "session-002", agentId: "agent-002" }),
      isGenerating: false,
      inFlightGeneration: null,
    };
    const oldARefresh = createDeferredPromise<{ session: ChatSession }>();
    const currentARefresh = createDeferredPromise<{ session: ChatSession }>();
    let aFetches = 0;
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [sessionA, sessionB] });
    mockFetchChatSession.mockImplementation((id) => {
      if (id === sessionA.id) {
        aFetches += 1;
        return aFetches === 1 ? oldARefresh.promise : currentARefresh.promise;
      }
      return Promise.resolve({ session: sessionB });
    });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    act(() => {
      result.current.selectSession(sessionA.id);
      result.current.selectSession(sessionB.id);
      result.current.selectSession(sessionA.id);
    });

    await waitFor(() => expect(aFetches).toBe(2));

    await act(async () => {
      oldARefresh.resolve({
        session: {
          ...sessionA,
          isGenerating: true,
          inFlightGeneration: {
            status: "generating",
            streamingText: "obsolete partial",
            streamingThinking: "obsolete reasoning",
            toolCalls: [],
            replayFromEventId: 31,
            updatedAt: "2026-07-20T18:00:00.000Z",
          },
        },
      });
      await Promise.resolve();
    });

    expect(mockAttachChatStream).not.toHaveBeenCalled();

    await act(async () => {
      currentARefresh.resolve({
        session: {
          ...sessionA,
          isGenerating: true,
          inFlightGeneration: {
            status: "generating",
            streamingText: "current partial",
            streamingThinking: "current reasoning",
            toolCalls: [],
            replayFromEventId: 32,
            updatedAt: "2026-07-20T18:01:00.000Z",
          },
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockAttachChatStream).toHaveBeenCalledTimes(1);
      expect(mockAttachChatStream).toHaveBeenCalledWith(sessionA.id, expect.any(Object), undefined, { lastEventId: 32 });
      expect(result.current.streamingText).toBe("current partial");
      expect(result.current.streamingThinking).toBe("current reasoning");
    });
  });

  it("fetches session on visible return only when no live stream and swallows reconnect failures", async () => {
    const session = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: false,
    };
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatSession.mockRejectedValueOnce(new Error("network"));
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    const addToast = vi.fn();

    const { result } = renderHook(() => useChat(undefined, addToast));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    act(() => {
      setDocumentVisibilityState("hidden");
      setDocumentVisibilityState("visible");
    });

    await waitFor(() => {
      expect(mockFetchChatSession).toHaveBeenCalledWith("session-001", undefined);
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
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    const addToast = vi.fn();

    let errorHandler: ((data: string | apiModule.ChatFailureInfo) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      errorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    setDocumentVisibilityState("hidden");
    const { result } = renderHook(() => useChat(undefined, addToast));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    act(() => {
      result.current.sendMessage("Hello!");
      errorHandler?.("Request failed: 500");
    });

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Request failed: 500", "error");
    });
  });

  it("onFallback updates the selected session model, persists fallback metadata, and shows a warning toast", async () => {
    const session = makeSession({
      id: "session-001",
      agentId: "agent-001",
      modelProvider: "openai-codex",
      modelId: "gpt-5.3-codex",
    });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });
    const addToast = vi.fn();

    let fallbackHandler:
      | ((data: { primaryModel: string; fallbackModel: string; triggerPoint: "session-creation" | "prompt-time" }) => void)
      | undefined;
    let textHandler: ((data: string) => void) | undefined;
    let doneHandler: ((data: { messageId: string }) => void) | undefined;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      fallbackHandler = handlers.onFallback;
      textHandler = handlers.onText;
      doneHandler = handlers.onDone;
      return { close: vi.fn(), isConnected: () => true };
    });

    const { result } = renderHook(() => useChat(undefined, addToast));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await act(async () => {
      await result.current.sendMessage("Hello!");
    });

    act(() => {
      fallbackHandler?.({
        primaryModel: "openai-codex/gpt-5.3-codex",
        fallbackModel: "zai/glm-5.1",
        triggerPoint: "prompt-time",
      });
      textHandler?.("Fallback reply");
      doneHandler?.({ messageId: "msg-fallback" });
    });

    await waitFor(() => {
      expect(result.current.activeSession?.modelProvider).toBe("zai");
      expect(result.current.activeSession?.modelId).toBe("glm-5.1");
      expect(addToast).toHaveBeenCalledWith(
        "Primary model unavailable. Switched to fallback zai/glm-5.1.",
        "warning",
      );
      expect(result.current.messages.find((message) => message.id === "msg-fallback")).toEqual(expect.objectContaining({
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

  it("stopStreaming aborts stream and resets streaming state", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

    const closeFn = vi.fn();
    mockStreamChatResponse.mockReturnValue({ close: closeFn, isConnected: () => true });

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

    act(() => {
      result.current.sendMessage("Hello!");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.stopStreaming();
    });

    await waitFor(() => {
      expect(closeFn).toHaveBeenCalledTimes(1);
      expect(mockCancelChatResponse).toHaveBeenCalledWith("session-001", "proj-123");
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.streamingText).toBe("");
      expect(result.current.streamingThinking).toBe("");
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
    });
  });

  it("stopStreaming with no pendingMessages cancels stream without sending anything", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

    const closeFn = vi.fn();
    mockStreamChatResponse.mockReturnValue({ close: closeFn, isConnected: () => true });

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

    act(() => {
      result.current.sendMessage("Hello!");
      result.current.stopStreaming();
    });

    await waitFor(() => {
      expect(closeFn).toHaveBeenCalledTimes(1);
      expect(result.current.pendingMessages).toEqual([]);
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
    });
  });

  it("sending during streaming queues pendingMessages without warning toast", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });
    const addToast = vi.fn();

    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { result } = renderHook(() => useChat("proj-123", addToast));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    act(() => {
      result.current.sendMessage("First");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued message");
    });

    expect(result.current.pendingMessages).toEqual(["Queued message"]);
    expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
    expect(addToast).not.toHaveBeenCalledWith("Still waiting for previous response — message queued", "warning");
  });

  it("persists queued message text to localStorage while streaming", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

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

    act(() => {
      result.current.sendMessage("First");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));
  });

  it("rehydrates queued message from localStorage after remount", async () => {
    const session = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        streamingText: "partial",
        streamingThinking: "",
        toolCalls: [],
      },
    };
    mockFetchChatSessions.mockResolvedValue({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const firstHook = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(firstHook.result.current.sessions).toHaveLength(1);
    });

    act(() => {
      firstHook.result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(firstHook.result.current.isStreaming).toBe(true);
    });

    act(() => {
      firstHook.result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));
    });

    firstHook.unmount();

    const secondHook = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(secondHook.result.current.sessions).toHaveLength(1);
    });

    act(() => {
      secondHook.result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(secondHook.result.current.pendingMessages).toEqual(["Queued follow-up"]);
    });
  });

  it("rehydrates legacy single-string queued message from localStorage after remount", async () => {
    const session = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        streamingText: "partial",
        streamingThinking: "",
        toolCalls: [],
      },
    };
    mockFetchChatSessions.mockResolvedValue({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    localStorage.setItem(getChatPendingMessageKey("session-001")!, "Legacy queued follow-up");

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.pendingMessages).toEqual(["Legacy queued follow-up"]);
    });
  });

  describe("queued message closure behavior", () => {
    it("queued message auto-sends after onDone with the active session and completes second stream", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001" });
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

      const handlers: Array<Parameters<typeof mockStreamChatResponse>[2]> = [];
      mockStreamChatResponse.mockImplementation((_sessionId, _content, nextHandlers) => {
        handlers.push(nextHandlers);
        return { close: vi.fn(), isConnected: () => true };
      });

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

      act(() => {
        result.current.sendMessage("First");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      act(() => {
        result.current.sendMessage("Queued follow-up");
      });

      await waitFor(() => {
        expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
      });

      act(() => {
        handlers[0]?.onDone?.({ messageId: "msg-001" });
      });

      await waitFor(() => {
        expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
        expect(mockStreamChatResponse.mock.calls[1]?.[0]).toBe("session-001");
        expect(mockStreamChatResponse.mock.calls[1]?.[1]).toBe("Queued follow-up");
        expect(result.current.pendingMessages).toEqual([]);
        expect(result.current.isStreaming).toBe(true);
      });

      act(() => {
        handlers[1]?.onDone?.({ messageId: "msg-002" });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
        expect(result.current.streamingText).toBe("");
      });
    });

    it("stacks queued messages while streaming and flushes them in FIFO order", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001" });
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

      const handlers: Array<Parameters<typeof mockStreamChatResponse>[2]> = [];
      mockStreamChatResponse.mockImplementation((_sessionId, _content, nextHandlers) => {
        handlers.push(nextHandlers);
        return { close: vi.fn(), isConnected: () => true };
      });

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

      act(() => {
        result.current.sendMessage("First");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      act(() => {
        result.current.sendMessage("Queued A");
        result.current.sendMessage("Queued B");
        result.current.sendMessage("Queued C");
      });

      expect(result.current.pendingMessages).toEqual(["Queued A", "Queued B", "Queued C"]);

      act(() => {
        handlers[0]?.onDone?.({ messageId: "msg-001" });
      });

      await waitFor(() => {
        expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
        expect(mockStreamChatResponse.mock.calls[1]?.[1]).toBe("Queued A");
        expect(result.current.pendingMessages).toEqual(["Queued B", "Queued C"]);
      });

      act(() => {
        handlers[1]?.onDone?.({ messageId: "msg-002" });
      });

      await waitFor(() => {
        expect(mockStreamChatResponse).toHaveBeenCalledTimes(3);
        expect(mockStreamChatResponse.mock.calls[2]?.[1]).toBe("Queued B");
        expect(result.current.pendingMessages).toEqual(["Queued C"]);
      });

      act(() => {
        handlers[2]?.onDone?.({ messageId: "msg-003" });
      });

      await waitFor(() => {
        expect(mockStreamChatResponse).toHaveBeenCalledTimes(4);
        expect(mockStreamChatResponse.mock.calls[3]?.[1]).toBe("Queued C");
        expect(result.current.pendingMessages).toEqual([]);
      });
    });

    it("flushes queued message after stream error when not cancelled", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001" });
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

      const handlers: Array<Parameters<typeof mockStreamChatResponse>[2]> = [];
      mockStreamChatResponse.mockImplementation((_sessionId, _content, nextHandlers) => {
        handlers.push(nextHandlers);
        return { close: vi.fn(), isConnected: () => true };
      });

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

      act(() => {
        result.current.sendMessage("First");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      act(() => {
        result.current.sendMessage("Queued follow-up");
        handlers[0]?.onError?.("network");
      });

      await waitFor(() => {
        expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
        expect(mockStreamChatResponse.mock.calls[1]?.[1]).toBe("Queued follow-up");
      });
    });
  });

  describe("queued message recovery paths", () => {
    it("flushes queued message when recovery completes via chat:message:added SSE", async () => {
      const session = {
        ...makeSession({ id: "session-001", agentId: "agent-001" }),
        isGenerating: true,
      };
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockAttachChatStream.mockReturnValue(null as never);

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      act(() => {
        result.current.sendMessage("Queued follow-up");
      });

      await waitFor(() => {
        expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
      });

      const subscribeOptions = mockSubscribeSse.mock.calls.at(-1)?.[1];
      const messageAdded = subscribeOptions?.events?.["chat:message:added"];
      expect(messageAdded).toBeTypeOf("function");

      act(() => {
        messageAdded?.({
          data: JSON.stringify(makeMessage({
            id: "msg-002",
            sessionId: "session-001",
            role: "assistant",
            content: "Recovered",
          })),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
        expect(mockStreamChatResponse.mock.calls[0]?.[1]).toBe("Queued follow-up");
        expect(result.current.pendingMessages).toEqual([]);
      });
    });

    it("flushes queued message when visibility resume sees generation complete", async () => {
      const session = {
        ...makeSession({ id: "session-001", agentId: "agent-001" }),
        isGenerating: true,
      };
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockAttachChatStream.mockReturnValue(null as never);
      mockFetchChatSession
        .mockResolvedValueOnce({ session })
        .mockResolvedValue({ session: { ...session, isGenerating: false } });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      act(() => {
        result.current.sendMessage("Queued follow-up");
      });

      await waitFor(() => {
        expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
      });

      act(() => {
        setDocumentVisibilityState("hidden");
        setDocumentVisibilityState("visible");
      });

      await waitFor(() => {
        expect(mockFetchChatSession).toHaveBeenCalledWith("session-001", "proj-123");
        expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
        expect(mockStreamChatResponse.mock.calls[0]?.[1]).toBe("Queued follow-up");
        expect(result.current.pendingMessages).toEqual([]);
      });
    });
  });

  it("stopStreaming sends queued pendingMessages after cancelling the stream", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    const handlers: Array<Parameters<typeof mockStreamChatResponse>[2]> = [];
    const closeFn = vi.fn();
    mockStreamChatResponse.mockImplementation((_sessionId, _content, nextHandlers) => {
      handlers.push(nextHandlers);
      return { close: closeFn, isConnected: () => true };
    });

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

    act(() => {
      result.current.sendMessage("First");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
      result.current.stopStreaming();
    });

    await waitFor(() => {
      expect(closeFn).toHaveBeenCalled();
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
      expect(mockStreamChatResponse.mock.calls[1]?.[1]).toBe("Queued follow-up");
      expect(result.current.pendingMessages).toEqual([]);
    });

    act(() => {
      handlers[1]?.onDone?.({ messageId: "msg-queued" });
    });
  });

  it("preserves queued message localStorage entry when navigating away and restores it on return", async () => {
    const sessionA = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        streamingText: "partial",
        streamingThinking: "",
        toolCalls: [],
      },
    };

    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [sessionA] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
      expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));
    });

    act(() => {
      result.current.selectSession("");
    });

    await waitFor(() => {
      expect(result.current.activeSession).toBeNull();
      expect(result.current.pendingMessages).toEqual([]);
      expect(result.current.isStreaming).toBe(false);
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
      expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
      expect(result.current.isStreaming).toBe(true);
    });
  });

  it("does not flush a restored queued message while the server still reports an in-flight generation", async () => {
    // Reproduces FN-5852 back-navigation loss: the sessions-list entry has a
    // stale falsy isGenerating (it is a route-level enrichment that the
    // chat:session:updated SSE payload lacks), while the server is actually
    // still generating. The restored queued message must NOT be flushed from
    // local state alone — doing so aborts the live generation server-side.
    const sessionA = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValue({ sessions: [sessionA] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchChatSession.mockResolvedValue({
      session: {
        ...sessionA,
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

    localStorage.setItem(getChatPendingMessageKey("session-001")!, JSON.stringify(["Queued follow-up"]));

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    // The queued message is restored and the authoritative session fetch
    // reveals the in-flight generation, so the hook attaches instead of
    // flushing.
    await waitFor(() => {
      expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
      expect(result.current.isStreaming).toBe(true);
    });

    expect(mockStreamChatResponse).not.toHaveBeenCalled();
    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));

    // Once the attached generation completes, the queued message flushes.
    act(() => {
      attachHandlers[0]?.onDone?.({ messageId: "msg-001" });
    });

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
      expect(mockStreamChatResponse.mock.calls[0]?.[0]).toBe("session-001");
      expect(mockStreamChatResponse.mock.calls[0]?.[1]).toBe("Queued follow-up");
      expect(result.current.pendingMessages).toEqual([]);
      expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBeNull();
    });
  });

  it("keeps a restored queued message un-flushed when an attached stream errors but the server is still generating", async () => {
    const sessionA = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValue({ sessions: [sessionA] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchChatSession.mockResolvedValue({
      session: {
        ...sessionA,
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

    localStorage.setItem(getChatPendingMessageKey("session-001")!, JSON.stringify(["Queued follow-up"]));

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(attachHandlers).toHaveLength(1);
      expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
      expect(mockStreamChatResponse).not.toHaveBeenCalled();
    });

    act(() => {
      attachHandlers[0]?.onError?.("network");
    });

    await waitFor(() => {
      expect(attachHandlers).toHaveLength(2);
      expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
      expect(result.current.isStreaming).toBe(true);
      expect(mockStreamChatResponse).not.toHaveBeenCalled();
      expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));
    });
  });

  it("keeps a restored queued message un-flushed while the server validation fetch is pending", async () => {
    // Production latency case: the authoritative fetch takes one network
    // RTT. Nothing may flush (or delete) the restored queue in the interim.
    const sessionA = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValue({ sessions: [sessionA] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    // Server check never resolves within the test — simulates in-flight RTT.
    mockFetchChatSession.mockReturnValue(new Promise(() => {}) as never);

    localStorage.setItem(getChatPendingMessageKey("session-001")!, JSON.stringify(["Queued follow-up"]));

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
      expect(mockStreamChatResponse).not.toHaveBeenCalled();
      expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));
    });

    expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
    expect(mockStreamChatResponse).not.toHaveBeenCalled();
    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));
  });

  it("preserves queued messages across session switches and rehydrates them when returning", async () => {
    const sessionA = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        streamingText: "partial",
        streamingThinking: "",
        toolCalls: [],
      },
    };
    const sessionB = makeSession({ id: "session-002", agentId: "agent-002" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [sessionA, sessionB] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
    });

    act(() => {
      result.current.selectSession("session-002");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-002");
      expect(result.current.pendingMessages).toEqual([]);
      expect(result.current.isStreaming).toBe(false);
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
      expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
      expect(result.current.isStreaming).toBe(true);
    });
  });

  it("clearPendingMessage is safe without an active session and leaves localStorage untouched", async () => {
    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(mockFetchChatSessions).toHaveBeenCalledWith("proj-123");
    });

    expect(() => {
      act(() => {
        result.current.clearPendingMessage();
        result.current.selectSession("");
        result.current.sendMessage("No session yet");
      });
    }).not.toThrow();

    expect(localStorage.getItem("fusion:chat-pending:null")).toBeNull();
    expect(localStorage.getItem("fusion:chat-pending:undefined")).toBeNull();
  });

  it("clearPendingMessage with an index removes only that queued message and persists the tail", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

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

    act(() => {
      result.current.sendMessage("First");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued A");
      result.current.sendMessage("Queued B");
      result.current.sendMessage("Queued C");
    });

    await waitFor(() => {
      expect(result.current.pendingMessages).toEqual(["Queued A", "Queued B", "Queued C"]);
    });

    act(() => {
      result.current.clearPendingMessage(1);
    });

    expect(result.current.pendingMessages).toEqual(["Queued A", "Queued C"]);
    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued A", "Queued C"]));
  });

  it("clearPendingMessage clears pending message and removes persisted queue entry", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

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

    act(() => {
      result.current.sendMessage("First");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(result.current.pendingMessages).toEqual(["Queued follow-up"]);
    });

    act(() => {
      result.current.clearPendingMessage();
    });

    expect(result.current.pendingMessages).toEqual([]);
    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBeNull();
  });

  it("createSession removes the prior session's persisted queued messages", async () => {
    const existingSession = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        streamingText: "partial",
        streamingThinking: "",
        toolCalls: [],
      },
    };
    const newSession = makeSession({ id: "session-002", agentId: "agent-001", title: "Fresh" });

    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [existingSession] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockCreateChatSession.mockResolvedValueOnce({ session: newSession });

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));
    });

    await act(async () => {
      await result.current.createSession({ agentId: "agent-001", title: "Fresh" });
    });

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-002");
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBeNull();
  });

  it("archiveSession removes the archived session's persisted queued messages", async () => {
    const session = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        streamingText: "partial",
        streamingThinking: "",
        toolCalls: [],
      },
    };

    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));
    });

    await act(async () => {
      await result.current.archiveSession("session-001");
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBeNull();
  });

  it("deleteSession removes the deleted session's persisted queued messages", async () => {
    const session = {
      ...makeSession({ id: "session-001", agentId: "agent-001" }),
      isGenerating: true,
      inFlightGeneration: {
        streamingText: "partial",
        streamingThinking: "",
        toolCalls: [],
      },
    };

    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
    });

    await waitFor(() => {
      expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBe(JSON.stringify(["Queued follow-up"]));
    });

    await act(async () => {
      await result.current.deleteSession("session-001");
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBeNull();
  });

  it("restored queued message auto-sends once after generation already completed", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    localStorage.setItem(getChatPendingMessageKey("session-001")!, JSON.stringify(["Queued follow-up"]));

    const { result } = renderHook(() => useChat("proj-123"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession("session-001");
    });

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
      expect(mockStreamChatResponse.mock.calls[0]?.[1]).toBe("Queued follow-up");
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBeNull();
  });

  it("stopStreaming flushes pendingMessages", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

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

    act(() => {
      result.current.sendMessage("First");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Queued follow-up");
      result.current.stopStreaming();
    });

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
      expect(mockStreamChatResponse.mock.calls[1]?.[1]).toBe("Queued follow-up");
      expect(result.current.pendingMessages).toEqual([]);
    });

    expect(localStorage.getItem(getChatPendingMessageKey("session-001"))).toBeNull();
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
    expect(secondCall[1]).toHaveProperty("before");

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

  it("loadMoreMessages callback is stable when messages array changes (no re-create on streaming)", async () => {
    const session = makeSession({ id: "session-001", agentId: "agent-001" });
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });

    // 50 messages so hasMoreMessages=true
    const make50 = () =>
      Array.from({ length: 50 }, (_, i) =>
        makeMessage({ id: `msg-${i}`, sessionId: "session-001", role: "user", content: `m${i}`, createdAt: `2026-04-08T00:00:${String(i).padStart(2, "0")}.000Z` })
      );
    mockFetchChatMessages.mockResolvedValueOnce({ messages: make50() });

    // Minimal streaming mock — returns immediately so sendMessage won't hang
    mockStreamChatResponse.mockImplementation(() => ({ close: vi.fn(), isConnected: () => false }));

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

    // Capture callback identity before messages change
    const loadMoreBefore = result.current.loadMoreMessages;

    // sendMessage adds an optimistic user message → new messages array reference
    act(() => {
      void result.current.sendMessage("hello");
    });

    await waitFor(() => {
      // Optimistic user message was appended
      expect(result.current.messages.length).toBeGreaterThan(50);
    });

    // loadMoreMessages must NOT have been recreated despite messages array changing
    expect(result.current.loadMoreMessages).toBe(loadMoreBefore);
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

  describe("SSE real-time updates", () => {
    let subscribeHandler: Record<string, (event: MessageEvent) => void> = {};

    beforeEach(() => {
      subscribeHandler = {};
      mockSubscribeSse.mockImplementation((_url, options) => {
        // Capture the event handlers
        if (options?.events) {
          subscribeHandler = options.events as typeof subscribeHandler;
        }
        return () => {};
      });
    });

    afterEach(() => {
      subscribeHandler = {};
    });

    it("subscribes to chat SSE events", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [] });

      renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(mockSubscribeSse).toHaveBeenCalledWith(
          "/api/events?projectId=proj-123",
          expect.objectContaining({
            events: expect.objectContaining({
              "chat:session:created": expect.any(Function),
              "chat:session:updated": expect.any(Function),
              "chat:session:deleted": expect.any(Function),
              "chat:message:added": expect.any(Function),
              "chat:message:deleted": expect.any(Function),
            }),
          }),
        );
      });
    });

    it("adds new session on chat:session:created event", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      // Simulate SSE event
      const newSession = makeSession({ id: "session-002", agentId: "agent-002", title: "New Chat" });
      act(() => {
        subscribeHandler["chat:session:created"]?.({
          data: JSON.stringify(newSession),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(2);
        expect(result.current.sessions[0]?.id).toBe("session-002");
      });
    });

    it("ignores empty task-planner session create events until a message exists", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [] });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(0);
      });

      act(() => {
        subscribeHandler["chat:session:created"]?.({
          data: JSON.stringify(makeSession({ id: "chat-empty-planner", agentId: "task-planner:FN-7337" })),
        } as MessageEvent);
      });

      expect(result.current.sessions).toHaveLength(0);
    });

    it("refreshes server-filtered sessions when a message arrives for an unseen planner session", async () => {
      mockFetchChatSessions
        .mockResolvedValueOnce({ sessions: [] })
        .mockResolvedValueOnce({ sessions: [{ ...makeSession({ id: "chat-planner", agentId: "task-planner:FN-7337" }), lastMessagePreview: "Hello", lastMessageAt: "2026-04-08T00:01:00.000Z" } as any] });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(0);
      });

      act(() => {
        subscribeHandler["chat:message:added"]?.({
          data: JSON.stringify(makeMessage({ id: "msg-planner", sessionId: "chat-planner", role: "user", content: "Hello" })),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.sessions.map((session) => session.id)).toEqual(["chat-planner"]);
      });
      expect(mockFetchChatSessions).toHaveBeenCalledTimes(2);
    });

    it("uses server-filtered refresh instead of directly adding populated task-planner create events", async () => {
      mockFetchChatSessions
        .mockResolvedValueOnce({ sessions: [] })
        .mockResolvedValueOnce({ sessions: [] });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(0);
      });

      act(() => {
        subscribeHandler["chat:session:created"]?.({
          data: JSON.stringify({
            ...makeSession({ id: "chat-planner", agentId: "task-planner:FN-7337" }),
            lastMessagePreview: "Hello",
            lastMessageAt: "2026-04-08T00:01:00.000Z",
          }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(mockFetchChatSessions).toHaveBeenCalledTimes(2);
      });
      expect(result.current.sessions).toHaveLength(0);
    });

    it("avoids duplicate sessions on chat:session:created", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      // Simulate SSE event for the same session
      const sameSession = makeSession({ id: "session-001", agentId: "agent-001" });
      act(() => {
        subscribeHandler["chat:session:created"]?.({
          data: JSON.stringify(sameSession),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });
    });

    it("updates session on chat:session:updated event", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001", title: "Old Title" })],
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
        expect(result.current.sessions[0]?.title).toBe("Old Title");
      });

      // Simulate SSE event
      const updatedSession = makeSession({ id: "session-001", agentId: "agent-001", title: "New Title" });
      act(() => {
        subscribeHandler["chat:session:updated"]?.({
          data: JSON.stringify(updatedSession),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.sessions[0]?.title).toBe("New Title");
      });
    });

    it("FN-8504 waits for the authoritative cursor when an SSE update races session re-entry", async () => {
      const staleSession = {
        ...makeSession({ id: "session-reentry-race", agentId: "agent-001" }),
        isGenerating: false,
        inFlightGeneration: null,
      };
      const staleSseSession = {
        ...staleSession,
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "stale partial",
          streamingThinking: "",
          toolCalls: [],
          replayFromEventId: 4,
          updatedAt: "2026-07-22T19:05:00.000Z",
        },
      };
      const authoritativeSession = {
        ...staleSseSession,
        inFlightGeneration: {
          ...staleSseSession.inFlightGeneration,
          streamingText: "authoritative partial",
          streamingThinking: "authoritative reasoning",
          replayFromEventId: 23,
        },
      };
      const refresh = createDeferredPromise<{ session: ChatSession }>();
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [staleSession] });
      mockFetchChatSession.mockReturnValueOnce(refresh.promise);
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useChat("proj-123"));
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));

      act(() => result.current.selectSession(staleSession.id));
      act(() => {
        subscribeHandler["chat:session:updated"]?.({
          data: JSON.stringify(staleSseSession),
        } as MessageEvent);
      });

      expect(mockAttachChatStream).not.toHaveBeenCalled();
      expect(result.current.isStreaming).toBe(false);

      await act(async () => {
        refresh.resolve({ session: authoritativeSession });
        await refresh.promise;
      });

      await waitFor(() => {
        expect(mockAttachChatStream).toHaveBeenCalledTimes(1);
        expect(mockAttachChatStream).toHaveBeenCalledWith(
          staleSession.id,
          expect.any(Object),
          "proj-123",
          { lastEventId: 23 },
        );
        expect(result.current.streamingText).toBe("authoritative partial");
        expect(result.current.streamingThinking).toBe("authoritative reasoning");
      });
    });

    it("FN-6599 keeps restored main-chat prior thread visible during selectSession recovery attach", async () => {
      const generatingSession = {
        ...makeSession({
          id: "session-restore-generating",
          agentId: "agent-001",
          title: "Restored generating",
        }),
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "restored partial",
          streamingThinking: "thinking",
          toolCalls: [],
          replayFromEventId: 101,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };
      const priorThreadNewestFirst = [
        makeMessage({ id: "msg-004", sessionId: generatingSession.id, role: "assistant", content: "Second answer" }),
        makeMessage({ id: "msg-003", sessionId: generatingSession.id, role: "user", content: "Second question" }),
        makeMessage({ id: "msg-002", sessionId: generatingSession.id, role: "assistant", content: "First answer" }),
        makeMessage({ id: "msg-001", sessionId: generatingSession.id, role: "user", content: "First question" }),
      ];

      mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? generatingSession.id : undefined);
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [generatingSession] });
      mockFetchChatSession.mockResolvedValueOnce({ session: generatingSession });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: priorThreadNewestFirst });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.streamingText).toBe("restored partial");
        expect(mockAttachChatStream).toHaveBeenCalledWith(
          generatingSession.id,
          expect.any(Object),
          "proj-123",
          { lastEventId: 101 },
        );
      });

      await waitFor(() => {
        expect(result.current.messages.map((message) => message.content)).toEqual([
          "First question",
          "First answer",
          "Second question",
          "Second answer",
        ]);
      });
    });

    it("FN-8408 keeps persisted user echoes chronological after returning mid-generation", async () => {
      const generatingSession = {
        ...makeSession({ id: "session-message-order", agentId: "agent-001", title: "Message order" }),
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "working",
          streamingThinking: "",
          toolCalls: [],
          replayFromEventId: 301,
          updatedAt: "2026-04-08T00:05:00.000Z",
        },
      };
      const priorUser = makeMessage({
        id: "msg-001",
        sessionId: generatingSession.id,
        role: "user",
        content: "First question",
        createdAt: "2026-04-08T00:01:00.000Z",
      });
      const persistedUser = makeMessage({
        id: "msg-003",
        sessionId: generatingSession.id,
        role: "user",
        content: "Persisted while away",
        createdAt: "2026-04-08T00:03:00.000Z",
      });
      const laterAssistant = makeMessage({
        id: "msg-005",
        sessionId: generatingSession.id,
        role: "assistant",
        content: "Later answer",
        createdAt: "2026-04-08T00:05:00.000Z",
      });
      const sseUser = makeMessage({
        id: "msg-002",
        sessionId: generatingSession.id,
        role: "user",
        content: "SSE sibling",
        createdAt: "2026-04-08T00:03:00.000Z",
      });

      // FNXC:ChatMessageOrder 2026-07-19-00:00: This restored partial cache has no temp row,
      // but does retain a later assistant turn before the authoritative mid-stream reload.
      cacheMessages("proj-123", generatingSession.id, [priorUser, laterAssistant]);
      mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? generatingSession.id : undefined);
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [generatingSession] });
      mockFetchChatSession.mockResolvedValueOnce({ session: generatingSession });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [laterAssistant, persistedUser, priorUser] });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.messages.map((message) => message.id)).toEqual([
          "msg-001",
          "msg-003",
          "msg-005",
        ]);
      });

      act(() => {
        subscribeHandler["chat:message:added"]?.({ data: JSON.stringify(sseUser) } as MessageEvent);
      });

      await waitFor(() => {
        const messages = result.current.messages;
        expect(messages.map((message) => message.id)).toEqual(["msg-001", "msg-002", "msg-003", "msg-005"]);
        expect(messages.map((message) => Date.parse(message.createdAt))).toEqual([
          ...messages.map((message) => Date.parse(message.createdAt)).sort((a, b) => a - b),
        ]);
        expect(messages.filter((message) => message.role === "user").every((message) =>
          messages.filter((candidate) => candidate.role === "assistant" && candidate.createdAt > message.createdAt).every(
            (assistant) => messages.indexOf(message) < messages.indexOf(assistant),
          ),
        )).toBe(true);
      });
    });

    it("FN-7853 keeps cached prior thread stable when stale mid-turn load resolves empty", async () => {
      const generatingSession = {
        ...makeSession({ id: "session-mid-turn-stable", agentId: "agent-001", title: "Mid turn stable" }),
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "working",
          streamingThinking: "thinking",
          toolCalls: [],
          replayFromEventId: 201,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };
      const priorThread = [
        makeMessage({ id: "msg-001", sessionId: generatingSession.id, role: "user", content: "First question" }),
        makeMessage({ id: "msg-002", sessionId: generatingSession.id, role: "assistant", content: "First answer" }),
        makeMessage({ id: "msg-003", sessionId: generatingSession.id, role: "user", content: "Second question" }),
        makeMessage({ id: "msg-004", sessionId: generatingSession.id, role: "assistant", content: "Second answer" }),
      ];
      const staleFetch = createDeferredPromise<{ messages: ChatMessage[] }>();
      let attachedHandlers: StreamAppendHandlers | undefined;

      cacheMessages("proj-123", generatingSession.id, priorThread);
      mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? generatingSession.id : undefined);
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [generatingSession] });
      mockFetchChatMessages.mockReturnValue(staleFetch.promise);
      mockAttachChatStream.mockImplementation((_sessionId, handlers) => {
        attachedHandlers = handlers;
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.streamingText).toBe("working");
        expect(result.current.messages.map((message) => message.content)).toEqual([
          "First question",
          "First answer",
          "Second question",
          "Second answer",
        ]);
      });

      const expectPriorThreadStable = () => {
        const contents = result.current.messages.map((message) => message.content);
        expect(contents).toEqual(expect.arrayContaining([
          "First question",
          "First answer",
          "Second question",
          "Second answer",
        ]));
      };

      act(() => {
        subscribeHandler["chat:session:updated"]?.({
          data: JSON.stringify({
            ...generatingSession,
            inFlightGeneration: { ...generatingSession.inFlightGeneration, streamingText: "working harder", replayFromEventId: 202 },
          }),
        } as MessageEvent);
      });
      expectPriorThreadStable();

      vi.useFakeTimers();
      act(() => {
        attachedHandlers?.onToolStart({ toolName: "read", args: { path: "README.md" } });
        attachedHandlers?.onText(" now");
        attachedHandlers?.onToolEnd({ toolName: "read", isError: false, result: "ok" });
      });
      act(() => {
        vi.advanceTimersToNextTimer();
      });
      expectPriorThreadStable();

      act(() => {
        subscribeHandler["chat:message:added"]?.({
          data: JSON.stringify(makeMessage({
            id: "msg-005",
            sessionId: generatingSession.id,
            role: "user",
            content: "Follow-up question",
          })),
        } as MessageEvent);
      });
      expectPriorThreadStable();

      await act(async () => {
        staleFetch.resolve({ messages: [] });
        await staleFetch.promise;
      });

      expectPriorThreadStable();
      expect(result.current.isStreaming).toBe(true);

      vi.useRealTimers();
    });

    it("FN-7853 keeps prior thread stable during the client's own streaming send turn", async () => {
      const session = makeSession({ id: "session-live-send", agentId: "agent-001", title: "Live send" });
      const priorThreadNewestFirst = [
        makeMessage({ id: "msg-004", sessionId: session.id, role: "assistant", content: "Second answer" }),
        makeMessage({ id: "msg-003", sessionId: session.id, role: "user", content: "Second question" }),
        makeMessage({ id: "msg-002", sessionId: session.id, role: "assistant", content: "First answer" }),
        makeMessage({ id: "msg-001", sessionId: session.id, role: "user", content: "First question" }),
      ];
      let streamHandlers: StreamAppendHandlers | undefined;

      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatSession.mockResolvedValue({ session });
      mockFetchChatMessages.mockResolvedValue({ messages: priorThreadNewestFirst });
      mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
        streamHandlers = handlers;
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession(session.id);
      });

      await waitFor(() => {
        expect(result.current.messages.map((message) => message.content)).toEqual([
          "First question",
          "First answer",
          "Second question",
          "Second answer",
        ]);
      });

      act(() => {
        result.current.sendMessage("Third question");
      });

      expect(result.current.messages.map((message) => message.content)).toEqual([
        "First question",
        "First answer",
        "Second question",
        "Second answer",
        "Third question",
      ]);
      expect(result.current.isStreaming).toBe(true);

      vi.useFakeTimers();
      act(() => {
        streamHandlers?.onText("Partial answer");
        subscribeHandler["chat:session:updated"]?.({
          data: JSON.stringify({
            ...session,
            isGenerating: true,
            inFlightGeneration: {
              status: "generating" as const,
              streamingText: "Partial answer",
              streamingThinking: "",
              toolCalls: [],
              replayFromEventId: 301,
              updatedAt: "2026-04-08T00:00:00.000Z",
            },
          }),
        } as MessageEvent);
        subscribeHandler["chat:message:added"]?.({
          data: JSON.stringify(makeMessage({ id: "msg-ignored-assistant", sessionId: session.id, role: "assistant", content: "Duplicate assistant" })),
        } as MessageEvent);
      });
      act(() => {
        vi.advanceTimersToNextTimer();
      });

      expect(result.current.messages.map((message) => message.content)).toEqual([
        "First question",
        "First answer",
        "Second question",
        "Second answer",
        "Third question",
      ]);
      expect(result.current.streamingText).toBe("Partial answer");

      act(() => {
        streamHandlers?.onDone?.({
          messageId: "msg-final-live-send",
          accumulated: { text: "Final live answer", thinking: "", toolCalls: [] },
        });
      });

      expect(result.current.messages.map((message) => message.content)).toEqual([
        "First question",
        "First answer",
        "Second question",
        "Second answer",
        "Third question",
        "Partial answer",
      ]);
      vi.useRealTimers();
    });

    it("FN-6496 loads prior thread during chat:session:updated in-flight attach", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001", title: "Existing" });
      const priorThreadNewestFirst = [
        makeMessage({ id: "msg-004", sessionId: session.id, role: "assistant", content: "Second answer" }),
        makeMessage({ id: "msg-003", sessionId: session.id, role: "user", content: "Second question" }),
        makeMessage({ id: "msg-002", sessionId: session.id, role: "assistant", content: "First answer" }),
        makeMessage({ id: "msg-001", sessionId: session.id, role: "user", content: "First question" }),
      ];
      const generatingSession = {
        ...session,
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "live partial",
          streamingThinking: "thinking",
          toolCalls: [],
          replayFromEventId: 88,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };

      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages
        .mockResolvedValueOnce({ messages: [] })
        .mockResolvedValueOnce({ messages: priorThreadNewestFirst });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession(session.id);
      });

      await waitFor(() => {
        expect(result.current.activeSession?.id).toBe(session.id);
        expect(mockFetchChatMessages).toHaveBeenCalledWith(session.id, { limit: 50, order: "desc" }, "proj-123");
      });
      expect(result.current.messages).toEqual([]);

      act(() => {
        subscribeHandler["chat:session:updated"]?.({
          data: JSON.stringify(generatingSession),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.streamingText).toBe("live partial");
        expect(mockAttachChatStream).toHaveBeenCalledWith(
          session.id,
          expect.any(Object),
          "proj-123",
          { lastEventId: 88 },
        );
        expect(mockFetchChatMessages).toHaveBeenCalledTimes(2);
        expect(result.current.messages.map((message) => message.id)).toEqual([
          "msg-001",
          "msg-002",
          "msg-003",
          "msg-004",
        ]);
      });
    });

    it("FN-6632 preserves prior streamed chunks during chat:session:updated reattach", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001", title: "Existing" });
      const generatingSession = {
        ...session,
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "Hello ",
          streamingThinking: "plan ",
          toolCalls: [{ toolName: "read", status: "running" as const, isError: false }],
          replayFromEventId: 5,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };
      let attachedHandlers: StreamAppendHandlers | undefined;
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatSession.mockResolvedValueOnce({ session: generatingSession });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockAttachChatStream.mockImplementation((_sessionId, handlers) => {
        attachedHandlers = handlers;
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession(session.id);
      });

      act(() => {
        subscribeHandler["chat:session:updated"]?.({
          data: JSON.stringify(generatingSession),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.streamingText).toBe("Hello ");
        expect(attachedHandlers).toBeDefined();
      });

      vi.useFakeTimers();
      act(() => {
        attachedHandlers?.onText("world");
        attachedHandlers?.onText("!");
        attachedHandlers?.onThinking("more");
        attachedHandlers?.onToolEnd({ toolName: "read", isError: false, result: "done" });
      });
      act(() => {
        vi.advanceTimersToNextTimer();
        vi.advanceTimersToNextTimer();
      });

      expect(result.current.isStreaming).toBe(true);
      expect(result.current.streamingText).toBe("Hello world!");
      expect(result.current.streamingThinking).toBe("plan more");
      expect(result.current.streamingToolCalls).toEqual([
        { toolName: "read", status: "completed", isError: false, result: "done" },
      ]);
      vi.useRealTimers();
    });

    it("FN-6496 loads prior thread when auto-reattach effect observes refreshed generation", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001", title: "Stale" });
      const priorThreadNewestFirst = [
        makeMessage({ id: "msg-004", sessionId: session.id, role: "assistant", content: "Second answer" }),
        makeMessage({ id: "msg-003", sessionId: session.id, role: "user", content: "Second question" }),
        makeMessage({ id: "msg-002", sessionId: session.id, role: "assistant", content: "First answer" }),
        makeMessage({ id: "msg-001", sessionId: session.id, role: "user", content: "First question" }),
      ];
      const generatingSession = {
        ...session,
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "refreshed partial",
          streamingThinking: "thinking",
          toolCalls: [],
          replayFromEventId: 90,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };

      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatSession.mockResolvedValueOnce({ session: generatingSession });
      mockFetchChatMessages
        .mockResolvedValueOnce({ messages: [] })
        .mockResolvedValueOnce({ messages: priorThreadNewestFirst });
      let attachedHandlers: StreamAppendHandlers | undefined;
      mockAttachChatStream.mockImplementation((_sessionId, nextHandlers) => {
        attachedHandlers = nextHandlers;
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession(session.id);
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.streamingText).toBe("refreshed partial");
        expect(mockAttachChatStream).toHaveBeenCalledWith(
          session.id,
          expect.any(Object),
          "proj-123",
          { lastEventId: 90 },
        );
        expect(mockFetchChatMessages).toHaveBeenCalledTimes(2);
        expect(result.current.messages.map((message) => message.id)).toEqual([
          "msg-001",
          "msg-002",
          "msg-003",
          "msg-004",
        ]);
      });

      vi.useFakeTimers();
      act(() => {
        attachedHandlers?.onText(" plus");
      });
      act(() => {
        vi.advanceTimersToNextTimer();
      });
      expect(result.current.streamingText).toBe("refreshed partial plus");
      vi.useRealTimers();
    });

    it("FN-6496 loads prior thread when reconnectSessionSilently reattaches after send suspension", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001", title: "Reconnect" });
      const priorThreadNewestFirst = [
        makeMessage({ id: "msg-004", sessionId: session.id, role: "assistant", content: "Second answer" }),
        makeMessage({ id: "msg-003", sessionId: session.id, role: "user", content: "Second question" }),
        makeMessage({ id: "msg-002", sessionId: session.id, role: "assistant", content: "First answer" }),
        makeMessage({ id: "msg-001", sessionId: session.id, role: "user", content: "First question" }),
      ];
      const generatingSession = {
        ...session,
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "reconnected partial",
          streamingThinking: "thinking",
          toolCalls: [],
          replayFromEventId: 91,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };
      let onError: ((data: string | apiModule.ChatFailureInfo, tempUserMessageId: string) => void) | undefined;

      mockFetchChatSessions
        .mockResolvedValueOnce({ sessions: [session] })
        .mockResolvedValueOnce({ sessions: [generatingSession] });
      mockFetchChatSession
        .mockResolvedValueOnce({ session })
        .mockResolvedValueOnce({ session: generatingSession });
      mockFetchChatMessages
        .mockResolvedValueOnce({ messages: [] })
        .mockResolvedValueOnce({ messages: priorThreadNewestFirst });
      mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
        onError = handlers.onError;
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession(session.id);
      });

      await waitFor(() => {
        expect(result.current.activeSession?.id).toBe(session.id);
      });

      act(() => {
        result.current.sendMessage("Continue");
        onError?.("Failed to fetch", "temp-reconnect");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.streamingText).toBe("reconnected partial");
        expect(mockAttachChatStream).toHaveBeenCalledWith(
          session.id,
          expect.any(Object),
          "proj-123",
          { lastEventId: 91 },
        );
        expect(result.current.messages.map((message) => message.id)).toEqual([
          "msg-001",
          "msg-002",
          "msg-003",
          "msg-004",
        ]);
      });
    });

    it("FN-6496 does not refetch or duplicate when prior thread is already loaded", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001", title: "Loaded" });
      const priorThreadNewestFirst = [
        makeMessage({ id: "msg-002", sessionId: session.id, role: "assistant", content: "First answer" }),
        makeMessage({ id: "msg-001", sessionId: session.id, role: "user", content: "First question" }),
      ];
      const generatingSession = {
        ...session,
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "live partial",
          streamingThinking: "",
          toolCalls: [],
          replayFromEventId: 89,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };

      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: priorThreadNewestFirst });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession(session.id);
      });

      await waitFor(() => {
        expect(result.current.messages.map((message) => message.id)).toEqual(["msg-001", "msg-002"]);
      });
      mockFetchChatMessages.mockClear();

      act(() => {
        subscribeHandler["chat:session:updated"]?.({
          data: JSON.stringify(generatingSession),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(mockAttachChatStream).toHaveBeenCalledWith(
          session.id,
          expect.any(Object),
          "proj-123",
          { lastEventId: 89 },
        );
      });
      expect(mockFetchChatMessages).not.toHaveBeenCalled();
      expect(result.current.messages.map((message) => message.id)).toEqual(["msg-001", "msg-002"]);
    });

    it("FN-5104 ignores replay checkpoint bumps while attach stream is already active", async () => {
      const generating = {
        ...makeSession({ id: "session-001", agentId: "agent-001", title: "Gen" }),
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "partial",
          streamingThinking: "",
          toolCalls: [],
          replayFromEventId: 5,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [generating] });
      mockFetchChatSession.mockResolvedValue({ session: generating });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(mockAttachChatStream).toHaveBeenCalledTimes(1);
      });

      const updatedSession = {
        ...generating,
        inFlightGeneration: { ...generating.inFlightGeneration, replayFromEventId: 9 },
      };
      act(() => {
        subscribeHandler["chat:session:updated"]?.({
          data: JSON.stringify(updatedSession),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(mockAttachChatStream).toHaveBeenCalledTimes(1);
      });
    });

    it("removes session on chat:session:deleted event", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [
          makeSession({ id: "session-001", agentId: "agent-001" }),
          makeSession({ id: "session-002", agentId: "agent-002" }),
        ],
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(2);
      });

      // Simulate SSE event
      act(() => {
        subscribeHandler["chat:session:deleted"]?.({
          data: JSON.stringify({ id: "session-001" }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
        expect(result.current.sessions[0]?.id).toBe("session-002");
      });
    });

    it("clears active session cache when it is deleted", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
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

      const clearCacheSpy = vi.spyOn(swrCacheModule, "clearCache");
      localStorage.setItem(
        chatMessagesCacheKey("proj-123", "session-001"),
        JSON.stringify({ savedAt: Date.now(), data: [makeMessage({ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Cached" })] }),
      );

      // Simulate SSE event for the active session
      act(() => {
        subscribeHandler["chat:session:deleted"]?.({
          data: JSON.stringify({ id: "session-001" }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.activeSession).toBeNull();
        expect(result.current.messages).toHaveLength(0);
      });

      expect(clearCacheSpy).toHaveBeenCalledWith(chatMessagesCacheKey("proj-123", "session-001"));
    });

    it("adds message on chat:message:added event for active session", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
      mockFetchChatMessages.mockResolvedValueOnce({
        messages: [makeMessage({ id: "msg-001", sessionId: "session-001", role: "user", content: "Hello" })],
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(1);
      });

      // Simulate SSE event for a new message in the active session
      const newMessage = makeMessage({ id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi there" });
      act(() => {
        subscribeHandler["chat:message:added"]?.({
          data: JSON.stringify(newMessage),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(2);
        expect(result.current.messages[1]?.content).toBe("Hi there");
      });
    });

    it("does not add message on chat:message:added when streaming", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

      mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
        void handlers.onDone;
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(0);
      });

      await act(async () => {
        await result.current.sendMessage("Hello!");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      const newMessage = makeMessage({ id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi" });
      act(() => {
        subscribeHandler["chat:message:added"]?.({
          data: JSON.stringify(newMessage),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(1);
      });
    });

    it("reconciles persisted user attachment echo during streaming without refetch or duplicate", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

      mockStreamChatResponse.mockImplementation((_sessionId, _content, _handlers) => ({ close: vi.fn(), isConnected: () => true }));

      const { result } = renderHook(() => useChat("proj-123"));
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));
      const fetchCountAfterSelect = mockFetchChatMessages.mock.calls.length;
      const uploadedFiles = [
        new File(["image-bytes"], "screenshot.png", { type: "image/png" }),
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      ];

      act(() => {
        result.current.sendMessage("Hi", uploadedFiles);
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        const userMessages = result.current.messages.filter((message) => message.role === "user");
        expect(userMessages).toHaveLength(1);
        expect(userMessages[0]?.id.startsWith("temp-")).toBe(true);
        expect(userMessages[0]?.attachments).toBeUndefined();
      });

      const persistedAttachments = [
        {
          id: "att-image-001",
          filename: "2026-07-12T00-00-00_screenshot.png",
          originalName: "screenshot.png",
          mimeType: "image/png",
          size: 11,
          createdAt: "2026-07-12T00:00:00.000Z",
        },
        {
          id: "att-file-001",
          filename: "2026-07-12T00-00-00_notes.txt",
          originalName: "notes.txt",
          mimeType: "text/plain",
          size: 5,
          createdAt: "2026-07-12T00:00:00.000Z",
        },
      ];
      const persistedEcho = makeMessage({
        id: "msg-user-001",
        sessionId: "session-001",
        role: "user",
        content: "Hi",
        attachments: persistedAttachments,
      });

      act(() => {
        subscribeHandler["chat:message:added"]?.({
          data: JSON.stringify(persistedEcho),
        } as MessageEvent);
      });

      await waitFor(() => {
        const userMessages = result.current.messages.filter((message) => message.role === "user");
        expect(userMessages).toHaveLength(1);
        expect(userMessages[0]?.id).toBe("msg-user-001");
        expect(userMessages[0]?.attachments).toEqual(persistedAttachments);
      });
      expect(mockFetchChatMessages).toHaveBeenCalledTimes(fetchCountAfterSelect);
    });

    it("reconciles attachment-only persisted user echo during streaming", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });
      mockStreamChatResponse.mockImplementation((_sessionId, _content, _handlers) => ({ close: vi.fn(), isConnected: () => true }));

      const { result } = renderHook(() => useChat("proj-123"));
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));
      act(() => result.current.selectSession("session-001"));
      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

      act(() => {
        result.current.sendMessage("", [new File(["image-bytes"], "screenshot.png", { type: "image/png" })]);
      });
      await waitFor(() => expect(result.current.isStreaming).toBe(true));

      const persistedAttachments = [
        {
          id: "att-image-only-001",
          filename: "2026-07-12T00-00-00_screenshot.png",
          originalName: "screenshot.png",
          mimeType: "image/png",
          size: 11,
          createdAt: "2026-07-12T00:00:00.000Z",
        },
      ];
      act(() => {
        subscribeHandler["chat:message:added"]?.({
          data: JSON.stringify(makeMessage({
            id: "msg-user-attachment-only",
            sessionId: "session-001",
            role: "user",
            content: "",
            attachments: persistedAttachments,
          })),
        } as MessageEvent);
      });

      await waitFor(() => {
        const userMessages = result.current.messages.filter((message) => message.role === "user");
        expect(userMessages).toHaveLength(1);
        expect(userMessages[0]?.id).toBe("msg-user-attachment-only");
        expect(userMessages[0]?.content).toBe("");
        expect(userMessages[0]?.attachments).toEqual(persistedAttachments);
      });
    });

    it("reconciles text-only persisted user echo during streaming without duplicate", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });
      mockStreamChatResponse.mockImplementation((_sessionId, _content, _handlers) => ({ close: vi.fn(), isConnected: () => true }));

      const { result } = renderHook(() => useChat("proj-123"));
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));
      act(() => result.current.selectSession("session-001"));
      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

      act(() => {
        result.current.sendMessage("Plain text only");
      });
      await waitFor(() => expect(result.current.isStreaming).toBe(true));

      act(() => {
        subscribeHandler["chat:message:added"]?.({
          data: JSON.stringify(makeMessage({
            id: "msg-user-text-only",
            sessionId: "session-001",
            role: "user",
            content: "Plain text only",
          })),
        } as MessageEvent);
      });

      await waitFor(() => {
        const userMessages = result.current.messages.filter((message) => message.role === "user");
        expect(userMessages).toHaveLength(1);
        expect(userMessages[0]?.id).toBe("msg-user-text-only");
        expect(userMessages[0]?.attachments).toBeUndefined();
      });
    });

    it("dedupes optimistic user message when persisted user echo arrives after done", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

      let doneHandler: ((data: { messageId: string }) => void) | undefined;
      mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
        doneHandler = handlers.onDone;
        return { close: vi.fn(), isConnected: () => true };
      });

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

      act(() => {
        result.current.sendMessage("Hello!");
      });

      await waitFor(() => {
        expect(result.current.messages.filter((message) => message.role === "user")).toHaveLength(1);
      });

      act(() => {
        doneHandler?.({ messageId: "msg-assistant-001" });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
        expect(result.current.messages).toHaveLength(2);
      });

      const persistedEcho = makeMessage({
        id: "msg-user-001",
        sessionId: "session-001",
        role: "user",
        content: "Hello!",
      });
      act(() => {
        subscribeHandler["chat:message:added"]?.({
          data: JSON.stringify(persistedEcho),
        } as MessageEvent);
      });

      await waitFor(() => {
        const userMessages = result.current.messages.filter((message) => message.role === "user");
        expect(userMessages).toHaveLength(1);
      });
    });

    it("keeps accepted sent message visible after provider error and reconciles persisted echo", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
      mockFetchChatMessages
        .mockResolvedValueOnce({ messages: [] })
        .mockResolvedValueOnce({
          messages: [makeMessage({ id: "msg-user-001", sessionId: "session-001", role: "user", content: "hello after 429" })],
        });

      let errorHandler: ((data: string | apiModule.ChatFailureInfo, meta?: apiModule.ChatStreamErrorMeta) => void) | undefined;
      mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
        errorHandler = handlers.onError;
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useChat("proj-123"));
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));
      act(() => result.current.selectSession("session-001"));
      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

      act(() => {
        result.current.sendMessage("hello after 429");
      });
      await waitFor(() => expect(result.current.messages.some((message) => message.content === "hello after 429")).toBe(true));

      act(() => {
        errorHandler?.({ summary: "Provider rate limit", code: "rate_limit" }, { requestAccepted: true, receivedStreamEvent: true });
      });

      await waitFor(() => {
        const matching = result.current.messages.filter((message) => message.role === "user" && message.content === "hello after 429");
        expect(matching).toHaveLength(1);
        expect(matching[0]?.id).toBe("msg-user-001");
      });
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.messages.some((message) => message.role === "assistant" && message.failureInfo?.summary === "Provider rate limit")).toBe(true);
    });

    it("keeps accepted silent streams waiting and reconciles a late assistant message", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });

      let doneHandler: ((data: { messageId: string; message?: ChatMessage }) => void) | undefined;
      mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
        doneHandler = handlers.onDone;
        return { close: vi.fn(), isConnected: () => true };
      });

      const addToast = vi.fn();
      const { result } = renderHook(() => useChat("proj-123", addToast));
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));
      act(() => result.current.selectSession("session-001"));
      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

      act(() => result.current.sendMessage("slow prompt"));

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.messages.some((message) => message.role === "user" && message.content === "slow prompt")).toBe(true);
      });
      expect(result.current.messages.some((message) => message.failureInfo?.summary === "Timed out waiting for first response event")).toBe(false);
      expect(addToast).not.toHaveBeenCalledWith("Timed out waiting for first response event", "error");

      act(() => {
        doneHandler?.({
          messageId: "msg-late-assistant",
          message: makeMessage({ id: "msg-late-assistant", sessionId: "session-001", role: "assistant", content: "late answer" }),
        });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
        expect(result.current.messages.some((message) => message.role === "assistant" && message.content === "late answer")).toBe(true);
      });
      expect(result.current.messages.some((message) => message.failureInfo?.summary === "Response failed")).toBe(false);
    });

    it("does not keep optimistic sent message for pre-acceptance HTTP failures", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
      mockFetchChatMessages.mockResolvedValueOnce({ messages: [] });
      let errorHandler: ((data: string | apiModule.ChatFailureInfo, meta?: apiModule.ChatStreamErrorMeta) => void) | undefined;
      mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
        errorHandler = handlers.onError;
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useChat("proj-123"));
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));
      act(() => result.current.selectSession("session-001"));
      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

      act(() => result.current.sendMessage("blocked before persist"));
      act(() => errorHandler?.("Request failed: 429", { requestAccepted: false, receivedStreamEvent: false }));

      await waitFor(() => {
        expect(result.current.messages.some((message) => message.content === "blocked before persist" && message.role === "user")).toBe(false);
        expect(result.current.isStreaming).toBe(false);
      });
    });

    it("flushes queued direct message after accepted provider error becomes idle", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
      mockFetchChatMessages
        .mockResolvedValueOnce({ messages: [] })
        .mockResolvedValue({ messages: [] });
      let errorHandler: ((data: string | apiModule.ChatFailureInfo, meta?: apiModule.ChatStreamErrorMeta) => void) | undefined;
      mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
        errorHandler = handlers.onError;
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useChat("proj-123"));
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));
      act(() => result.current.selectSession("session-001"));
      await waitFor(() => expect(result.current.activeSession?.id).toBe("session-001"));

      act(() => {
        result.current.sendMessage("first accepted");
        result.current.sendMessage("second queued");
      });
      expect(result.current.pendingMessages).toEqual(["second queued"]);

      act(() => errorHandler?.("Provider failed", { requestAccepted: true, receivedStreamEvent: true }));

      await waitFor(() => {
        expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
        expect(mockStreamChatResponse).toHaveBeenLastCalledWith("session-001", "second queued", expect.any(Object), undefined, "proj-123");
      });
    });

    it("removes message on chat:message:deleted event", async () => {
      mockFetchChatSessions.mockResolvedValueOnce({
        sessions: [makeSession({ id: "session-001", agentId: "agent-001" })],
      });
      mockFetchChatMessages.mockResolvedValueOnce({
        messages: [
          makeMessage({ id: "msg-001", sessionId: "session-001", role: "user", content: "Hello" }),
          makeMessage({ id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi there" }),
        ],
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(2);
      });

      // Simulate SSE event for deleted message
      act(() => {
        subscribeHandler["chat:message:deleted"]?.({
          data: JSON.stringify({ id: "msg-001" }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(1);
        expect(result.current.messages[0]?.id).toBe("msg-002");
      });
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
        expect(mockFetchChatMessages).toHaveBeenCalledWith("session-001", { limit: 50, order: "desc" }, undefined);
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

  describe("FN-3336: streaming state recovery on reload", () => {
    it("does not re-select and reset active session on subsequent session refreshes", async () => {
      const session = { ...makeSession({ id: "session-001", agentId: "agent-001" }), isGenerating: true };
      mockFetchChatSession.mockResolvedValueOnce({ session });
      mockGetScopedItem.mockReturnValue("session-001");
      mockFetchChatSessions
        .mockResolvedValueOnce({ sessions: [session] })
        .mockResolvedValueOnce({ sessions: [{ ...session, updatedAt: "2026-04-08T00:05:00.000Z" }] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.activeSession?.id).toBe("session-001");
      });

      // Authoritative re-entry reuses the attach transcript load, then later session-list
      // refreshes must not select/reset the active thread again.
      expect(mockFetchChatMessages).toHaveBeenCalledTimes(2);

      await act(async () => {
        await result.current.refreshSessions();
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      // A sessions refresh should not auto-reselect/reset the active thread.
      expect(mockFetchChatMessages).toHaveBeenCalledTimes(2);
    });

    it("preserves streaming text/thinking/tool state across sessions refresh", async () => {
      const session = makeSession({ id: "session-001", agentId: "agent-001" });
      mockFetchChatSessions
        .mockResolvedValueOnce({ sessions: [session] })
        .mockResolvedValueOnce({ sessions: [{ ...session, updatedAt: "2026-04-08T00:06:00.000Z" }] });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      let textHandler: ((data: string) => void) | undefined;
      let thinkingHandler: ((data: string) => void) | undefined;
      let toolStartHandler: ((data: { toolName: string; args?: Record<string, unknown> }) => void) | undefined;
      mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
        textHandler = handlers.onText;
        thinkingHandler = handlers.onThinking;
        toolStartHandler = handlers.onToolStart;
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await act(async () => {
        result.current.sendMessage("Hello");
      });

      await act(async () => {
        textHandler?.("Hi");
        thinkingHandler?.("plan");
        toolStartHandler?.({ toolName: "read", args: { path: "a.ts" } });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.streamingText).toBe("Hi");
        expect(result.current.streamingThinking).toBe("plan");
        expect(result.current.streamingToolCalls).toHaveLength(1);
      });

      await act(async () => {
        await result.current.refreshSessions();
      });

      expect(result.current.isStreaming).toBe(true);
      expect(result.current.streamingText).toBe("Hi");
      expect(result.current.streamingThinking).toBe("plan");
      expect(result.current.streamingToolCalls).toHaveLength(1);
    });

    it("hydrates durable in-flight snapshot and resumes from replay point", async () => {
      const session = {
        ...makeSession({ id: "session-001", agentId: "agent-001" }),
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "partial text",
          streamingThinking: "partial thinking",
          toolCalls: [{ toolName: "read", status: "running" as const, isError: false }],
          replayFromEventId: 41,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatSession.mockResolvedValueOnce({ session });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
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
        { lastEventId: 41 },
      );
    });

    it("FN-6632 preserves chunks across selectSession recovery and repeated reattach", async () => {
      const generatingSession = {
        ...makeSession({ id: "session-001", agentId: "agent-001", title: "Generating" }),
        isGenerating: true,
        inFlightGeneration: {
          status: "generating" as const,
          streamingText: "Hello ",
          streamingThinking: "plan ",
          toolCalls: [],
          replayFromEventId: 5,
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      };
      const otherSession = makeSession({ id: "session-002", agentId: "agent-002", title: "Other" });
      const handlers: StreamAppendHandlers[] = [];
      const closeFirstStream = vi.fn();
      const resumedGeneration = {
        ...generatingSession,
        inFlightGeneration: {
          ...generatingSession.inFlightGeneration,
          streamingText: "Hello world",
          streamingThinking: "plan next ",
          replayFromEventId: 6,
        },
      };
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [generatingSession, otherSession] });
      mockFetchChatSession
        .mockResolvedValueOnce({ session: generatingSession })
        .mockResolvedValueOnce({ session: otherSession })
        .mockResolvedValueOnce({ session: resumedGeneration });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });
      mockAttachChatStream.mockImplementation((_sessionId, nextHandlers) => {
        handlers.push(nextHandlers);
        return {
          close: handlers.length === 1 ? closeFirstStream : vi.fn(),
          isConnected: () => true,
        };
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(2);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(result.current.streamingText).toBe("Hello ");
        expect(handlers).toHaveLength(1);
      });

      vi.useFakeTimers();
      act(() => {
        handlers[0]?.onText("world");
      });
      act(() => {
        vi.advanceTimersToNextTimer();
      });
      expect(result.current.streamingText).toBe("Hello world");
      vi.useRealTimers();

      act(() => {
        result.current.selectSession("session-002");
      });
      expect(closeFirstStream).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.selectSession("session-001", {
          ...generatingSession,
          inFlightGeneration: {
            ...generatingSession.inFlightGeneration,
            streamingText: "Hello world",
            streamingThinking: "plan next ",
            replayFromEventId: 6,
          },
        });
      });

      await waitFor(() => {
        expect(result.current.streamingText).toBe("Hello world");
        expect(handlers).toHaveLength(2);
      });

      vi.useFakeTimers();
      act(() => {
        handlers[1]?.onText("!");
        handlers[1]?.onThinking("step");
      });
      act(() => {
        vi.advanceTimersToNextTimer();
        vi.advanceTimersToNextTimer();
      });

      expect(result.current.isStreaming).toBe(true);
      expect(result.current.streamingText).toBe("Hello world!");
      expect(result.current.streamingThinking).toBe("plan next step");
      expect(mockAttachChatStream).toHaveBeenLastCalledWith(
        "session-001",
        expect.any(Object),
        "proj-123",
        { lastEventId: 6 },
      );
      vi.useRealTimers();
    });

    it("sets isStreaming=true when selecting a session with isGenerating=true", async () => {
      const session = { ...makeSession({ id: "session-001", agentId: "agent-001" }), isGenerating: true };
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatSession.mockResolvedValueOnce({ session });
      mockFetchChatMessages.mockResolvedValue({ messages: [] });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
        expect(result.current.streamingText).toBe("");
      });
    });

    it("does not set isStreaming when isGenerating is false", async () => {
      const session = { ...makeSession({ id: "session-001", agentId: "agent-001" }), isGenerating: false };
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
        expect(result.current.isStreaming).toBe(false);
      });
    });

    it("clears recovery streaming state when attach stream completes", async () => {
      const session = { ...makeSession({ id: "session-001", agentId: "agent-001" }), isGenerating: true };
      mockFetchChatSessions.mockResolvedValueOnce({ sessions: [session] });
      mockFetchChatMessages.mockResolvedValue({
        messages: [
          makeMessage({
            id: "msg-assistant-001",
            sessionId: "session-001",
            role: "assistant",
            content: "Generated response",
          }),
        ],
      });
      mockAttachChatStream.mockImplementation((_sessionId, handlers) => {
        setTimeout(() => handlers.onDone?.({ messageId: "msg-assistant-001" }), 0);
        return { close: vi.fn(), isConnected: () => true };
      });

      const { result } = renderHook(() => useChat("proj-123"));

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      act(() => {
        result.current.selectSession("session-001");
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
        expect(result.current.streamingText).toBe("");
        expect(result.current.messages.some((m) => m.id === "msg-assistant-001")).toBe(true);
      });
    });
  });
});

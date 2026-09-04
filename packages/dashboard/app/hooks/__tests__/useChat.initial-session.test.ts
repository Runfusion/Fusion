import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../useChat";
import * as api from "../../api";
import type { EnrichedChatSession } from "@fusion/core";

vi.mock("../../api", () => ({
  fetchChatSessions: vi.fn(),
  fetchChatTags: vi.fn().mockResolvedValue({ tags: [] }),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  backfillChatSessionToStash: vi.fn(),
  attachChatStream: vi.fn(),
  streamChatResponse: vi.fn(),
  cancelChatResponse: vi.fn(),
  createChatTag: vi.fn(),
  renameChatTag: vi.fn(),
  deleteChatTag: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

const fetchChatSessions = vi.mocked(api.fetchChatSessions);
const fetchChatSession = vi.mocked(api.fetchChatSession);
const fetchChatMessages = vi.mocked(api.fetchChatMessages);
const createChatSession = vi.mocked(api.createChatSession);
const attachChatStream = vi.mocked(api.attachChatStream);
const streamChatResponse = vi.mocked(api.streamChatResponse);

const PROJECT_ID = "project-initial-session";
const ACTIVE_SESSION_KEY = `kb:${PROJECT_ID}:kb-chat-active-session`;

function session(
  overrides: Partial<EnrichedChatSession> & Pick<EnrichedChatSession, "id">,
): EnrichedChatSession {
  return {
    id: overrides.id,
    agentId: overrides.agentId ?? "agent-1",
    tags: overrides.tags ?? [],
    status: overrides.status ?? "active",
    title: overrides.title ?? null,
    projectId: overrides.projectId ?? PROJECT_ID,
    modelProvider: overrides.modelProvider ?? null,
    modelId: overrides.modelId ?? null,
    thinkingLevel: overrides.thinkingLevel ?? null,
    memoryFocus: overrides.memoryFocus ?? null,
    pinnedAt: overrides.pinnedAt ?? null,
    cliSessionFile: overrides.cliSessionFile ?? null,
    cliExecutorAdapterId: overrides.cliExecutorAdapterId ?? null,
    inFlightGeneration: overrides.inFlightGeneration ?? null,
    createdAt: overrides.createdAt ?? "2026-08-27T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-27T00:00:00.000Z",
    isGenerating: overrides.isGenerating,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useChat initial session isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    fetchChatSessions.mockResolvedValue({ sessions: [] });
    fetchChatSession.mockImplementation(async (id) => ({ session: session({ id }) }));
    fetchChatMessages.mockResolvedValue({ messages: [] });
    createChatSession.mockImplementation(async (input) => ({
      session: session({ id: "created-session", agentId: input.agentId, title: input.title ?? null }),
    }));
    attachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    streamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps initialSession active on the first render while the session list is pending", async () => {
    const initial = session({ id: "window-session" });
    const list = deferred<{ sessions: EnrichedChatSession[] }>();
    fetchChatSessions.mockReturnValueOnce(list.promise);

    const { result } = renderHook(() => useChat(PROJECT_ID, undefined, { initialSession: initial }));

    expect(result.current.activeSession?.id).toBe(initial.id);
    expect(result.current.sessionsLoading).toBe(true);

    await act(async () => list.resolve({ sessions: [initial] }));
    await waitFor(() => {
      expect(fetchChatSession).toHaveBeenCalledWith(initial.id, PROJECT_ID);
      expect(fetchChatMessages).toHaveBeenCalledWith(initial.id, { limit: 50, order: "desc" }, PROJECT_ID);
    });
  });

  it("keeps initialSession active when the session-list fetch rejects", async () => {
    const initial = session({ id: "window-session" });
    fetchChatSessions.mockRejectedValueOnce(new Error("offline"));

    const { result } = renderHook(() => useChat(PROJECT_ID, undefined, { initialSession: initial }));

    expect(result.current.activeSession?.id).toBe(initial.id);
    await waitFor(() => expect(result.current.sessionsLoading).toBe(false));
    expect(result.current.activeSession?.id).toBe(initial.id);
    expect(fetchChatSession).toHaveBeenCalledWith(initial.id, PROJECT_ID);
    expect(fetchChatMessages).toHaveBeenCalledWith(initial.id, { limit: 50, order: "desc" }, PROJECT_ID);
  });

  it("does not persist a secondary window selection", async () => {
    const initial = session({ id: "window-session" });
    const other = session({ id: "other-session" });
    fetchChatSessions.mockResolvedValueOnce({ sessions: [initial, other] });

    const { result } = renderHook(() => useChat(PROJECT_ID, undefined, {
      initialSession: initial,
      persistActiveSession: false,
    }));

    await waitFor(() => expect(result.current.sessionsLoading).toBe(false));
    act(() => result.current.selectSession(other.id, other));

    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
  });

  it("waits for sessions before restoring the legacy saved selection", async () => {
    const saved = session({ id: "saved-session" });
    const list = deferred<{ sessions: EnrichedChatSession[] }>();
    localStorage.setItem(ACTIVE_SESSION_KEY, saved.id);
    fetchChatSessions.mockReturnValueOnce(list.promise);

    const { result } = renderHook(() => useChat(PROJECT_ID));

    expect(result.current.activeSession).toBeNull();
    await act(async () => list.resolve({ sessions: [saved] }));

    await waitFor(() => expect(result.current.activeSession?.id).toBe(saved.id));
    expect(fetchChatSession).toHaveBeenCalledWith(saved.id, PROJECT_ID);
    expect(fetchChatMessages).toHaveBeenCalledWith(saved.id, { limit: 50, order: "desc" }, PROJECT_ID);
  });

  /*
  FNXC:ChatWindows 2026-08-27-09:10:
  A new-window create must add the new session without taking ownership from an active streaming
  conversation. The ordinary create path remains the deliberate reset-and-select operation.
  */
  it("keeps an active streaming session and queued composer state only for keepActiveSession", async () => {
    const active = session({ id: "active-session", isGenerating: true });
    const retainedStream = { close: vi.fn(), isConnected: () => true };
    fetchChatSessions.mockResolvedValueOnce({ sessions: [active] });
    fetchChatSession.mockResolvedValue({ session: active });
    attachChatStream.mockReturnValueOnce(retainedStream);
    createChatSession
      .mockResolvedValueOnce({ session: session({ id: "kept-session" }) })
      .mockResolvedValueOnce({ session: session({ id: "selected-session" }) });

    const { result } = renderHook(() => useChat(PROJECT_ID, undefined, { initialSession: active }));

    await waitFor(() => expect(attachChatStream).toHaveBeenCalledWith(active.id, expect.any(Object), PROJECT_ID, {}));
    act(() => result.current.sendMessage("queued composer message"));
    await waitFor(() => expect(result.current.pendingMessages).toEqual(["queued composer message"]));

    await act(async () => {
      await result.current.createSession({ agentId: "agent-2", title: "Kept" }, { keepActiveSession: true });
    });

    expect(result.current.activeSession?.id).toBe(active.id);
    expect(result.current.pendingMessages).toEqual(["queued composer message"]);
    expect(retainedStream.close).not.toHaveBeenCalled();
    expect(result.current.sessions.map((item) => item.id)).toEqual(expect.arrayContaining([active.id, "kept-session"]));

    await act(async () => {
      await result.current.createSession({ agentId: "agent-3", title: "Selected" });
    });

    await waitFor(() => expect(result.current.activeSession?.id).toBe("selected-session"));
    expect(result.current.pendingMessages).toEqual([]);
    expect(retainedStream.close).toHaveBeenCalledTimes(1);
    expect(fetchChatSession).toHaveBeenCalledWith("selected-session", PROJECT_ID);
    expect(fetchChatMessages).toHaveBeenCalledWith("selected-session", { limit: 50, order: "desc" }, PROJECT_ID);
    expect(result.current.sessions.map((item) => item.id)).toEqual(expect.arrayContaining(["selected-session", "kept-session"]));
  });
});

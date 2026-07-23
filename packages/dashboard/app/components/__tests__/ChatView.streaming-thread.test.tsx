import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import type { ChatMessage, ChatSession } from "@fusion/core";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchChatSessions: vi.fn(),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  streamChatResponse: vi.fn(),
  attachChatStream: vi.fn(),
  cancelChatResponse: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([
    { id: "agent-001", name: "Alpha", role: "executor", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
  ]),
  fetchModels: vi.fn().mockResolvedValue({
    models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 }],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4-5",
  }),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

vi.mock("../../hooks/useChatRooms", () => ({
  useChatRooms: vi.fn(),
}));

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});

import * as apiModule from "../../api";
import * as projectStorageModule from "../../utils/projectStorage";
import * as sseBusModule from "../../sse-bus";
import * as useChatRoomsModule from "../../hooks/useChatRooms";

const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockFetchChatSession = vi.mocked(apiModule.fetchChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockAttachChatStream = vi.mocked(apiModule.attachChatStream);
const mockGetScopedItem = vi.mocked(projectStorageModule.getScopedItem);
const mockSubscribeSse = vi.mocked(sseBusModule.subscribeSse);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);

const defaultRoomsState: UseChatRoomsResult = {
  rooms: [],
  roomsLoading: false,
  roomsError: null,
  activeRoom: null,
  activeRoomMembers: [],
  messages: [],
  messagesLoading: false,
  selectRoom: vi.fn(),
  createRoom: vi.fn(),
  deleteRoom: vi.fn(),
  sendRoomMessage: vi.fn(),
  refreshRooms: vi.fn(),
};

function makeSession(overrides: Partial<ChatSession> & Pick<ChatSession, "id" | "agentId">): ChatSession {
  return {
    id: overrides.id,
    agentId: overrides.agentId,
    status: overrides.status ?? "active",
    title: overrides.title ?? null,
    projectId: overrides.projectId ?? null,
    modelProvider: overrides.modelProvider ?? null,
    modelId: overrides.modelId ?? null,
    createdAt: overrides.createdAt ?? "2026-04-08T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-08T00:00:00.000Z",
    isGenerating: overrides.isGenerating,
    inFlightGeneration: overrides.inFlightGeneration,
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

type StreamAppendHandlers = {
  onText: (delta: string) => void;
  onToolStart: (data: { toolName: string; args?: Record<string, unknown> }) => void;
  onToolEnd: (data: { toolName: string; isError: boolean; result?: unknown }) => void;
};

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function cacheMessages(projectId: string, sessionId: string, messages: ChatMessage[]) {
  localStorage.setItem(
    `kb-dashboard-chat-messages-cache:${projectId}:${sessionId}`,
    JSON.stringify({ savedAt: Date.now(), data: messages }),
  );
}

describe("FN-6599 ChatView streaming prior thread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockUseChatRooms.mockReturnValue(defaultRoomsState);
    mockGetScopedItem.mockReturnValue(undefined);
    mockSubscribeSse.mockReturnValue(() => {});
    mockFetchChatSession.mockResolvedValue({ session: makeSession({ id: "session-001", agentId: "agent-001" }) });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["desktop", 1280],
    ["mobile", 390],
  ])("FN-6599 renders the restored main-chat prior thread while the assistant bubble streams on %s", async (_label, width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    const generatingSession = makeSession({
      id: "session-restored-streaming",
      agentId: "agent-001",
      title: "Restored streaming",
      isGenerating: true,
      inFlightGeneration: {
        status: "generating" as const,
        streamingText: "live partial response",
        streamingThinking: "thinking",
        toolCalls: [],
        replayFromEventId: 101,
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    });
    const priorThreadNewestFirst = [
      makeMessage({ id: "msg-004", sessionId: generatingSession.id, role: "assistant", content: "Second answer" }),
      makeMessage({ id: "msg-003", sessionId: generatingSession.id, role: "user", content: "Second question" }),
      makeMessage({ id: "msg-002", sessionId: generatingSession.id, role: "assistant", content: "First answer" }),
      makeMessage({ id: "msg-001", sessionId: generatingSession.id, role: "user", content: "First question" }),
    ];

    mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? generatingSession.id : undefined);
    mockFetchChatSessions.mockResolvedValue({ sessions: [generatingSession] });
    mockFetchChatMessages.mockResolvedValue({ messages: priorThreadNewestFirst });

    await act(async () => {
      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText("live partial response")).toBeInTheDocument();
    });

    expect(await screen.findByText("First question")).toBeInTheDocument();
    expect(screen.getByText("First answer")).toBeInTheDocument();
    expect(screen.getByText("Second question")).toBeInTheDocument();
    expect(screen.getByText("Second answer")).toBeInTheDocument();
  });

  it.each([
    ["desktop", 1280],
    ["mobile", 390],
  ])("FN-8504 restores the authoritative in-flight bubble after leaving and re-entering on %s", async (_label, width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    const generatingSession = makeSession({
      id: "session-reentry",
      agentId: "agent-001",
      title: "Re-entry",
      isGenerating: true,
      inFlightGeneration: {
        status: "generating" as const,
        streamingText: "authoritative partial response",
        streamingThinking: "authoritative reasoning",
        toolCalls: [{ toolName: "read", status: "running" as const, isError: false, args: { path: "README.md" } }],
        replayFromEventId: 23,
        updatedAt: "2026-07-20T19:15:00.000Z",
      },
    });
    const priorMessage = makeMessage({ id: "msg-prior", sessionId: generatingSession.id, role: "user", content: "Prior question" });
    mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? generatingSession.id : undefined);
    mockFetchChatSessions.mockResolvedValue({ sessions: [generatingSession] });
    mockFetchChatSession.mockResolvedValue({ session: generatingSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [priorMessage] });

    const firstView = render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await screen.findByText("authoritative partial response");
    firstView.unmount();

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("authoritative partial response")).toBeInTheDocument();
      expect(screen.getByText("Thinking")).toBeInTheDocument();
      expect(screen.getByText("read")).toBeInTheDocument();
      expect(screen.getByText("running")).toBeInTheDocument();
      expect(screen.getByText("Prior question")).toBeInTheDocument();
      expect(mockAttachChatStream).toHaveBeenLastCalledWith(
        generatingSession.id,
        expect.any(Object),
        "proj-123",
        { lastEventId: 23 },
      );
    });
    expect(mockAttachChatStream).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["desktop", 1280],
    ["mobile", 390],
  ])("FN-7853 keeps cached multi-turn prior thread visible across mid-turn churn on %s", async (_label, width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    const generatingSession = makeSession({
      id: "session-mid-turn-stable",
      agentId: "agent-001",
      title: "Mid turn stable",
      isGenerating: true,
      inFlightGeneration: {
        status: "generating" as const,
        streamingText: "working",
        streamingThinking: "thinking",
        toolCalls: [],
        replayFromEventId: 201,
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    });
    const priorThread = [
      makeMessage({ id: "msg-001", sessionId: generatingSession.id, role: "user", content: "First question" }),
      makeMessage({ id: "msg-002", sessionId: generatingSession.id, role: "assistant", content: "First answer" }),
      makeMessage({ id: "msg-003", sessionId: generatingSession.id, role: "user", content: "Second question" }),
      makeMessage({ id: "msg-004", sessionId: generatingSession.id, role: "assistant", content: "Second answer" }),
    ];
    const staleFetch = createDeferredPromise<{ messages: ChatMessage[] }>();
    let attachedHandlers: StreamAppendHandlers | undefined;
    let subscribeHandler: Record<string, (event: MessageEvent) => void> = {};

    cacheMessages("proj-123", generatingSession.id, priorThread);
    mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? generatingSession.id : undefined);
    mockFetchChatSessions.mockResolvedValue({ sessions: [generatingSession] });
    mockFetchChatMessages.mockReturnValue(staleFetch.promise);
    mockAttachChatStream.mockImplementation((_sessionId, handlers) => {
      attachedHandlers = handlers;
      return { close: vi.fn(), isConnected: () => true };
    });
    mockSubscribeSse.mockImplementation((_url, options) => {
      subscribeHandler = options?.events as typeof subscribeHandler;
      return () => {};
    });

    await act(async () => {
      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText("working")).toBeInTheDocument();
      expect(screen.getByText("First question")).toBeInTheDocument();
      expect(screen.getByText("First answer")).toBeInTheDocument();
      expect(screen.getByText("Second question")).toBeInTheDocument();
      expect(screen.getByText("Second answer")).toBeInTheDocument();
    });

    const expectPriorThreadVisible = () => {
      expect(screen.getByText("First question")).toBeInTheDocument();
      expect(screen.getByText("First answer")).toBeInTheDocument();
      expect(screen.getByText("Second question")).toBeInTheDocument();
      expect(screen.getByText("Second answer")).toBeInTheDocument();
    };

    /* FN-8339: streamed in-place growth must not override manual scroll-away on either breakpoint. */
    const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
    let scrollTop = 180;
    let scrollHeight = 1200;
    Object.defineProperty(messagesContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });
    Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, value: 240 });
    fireEvent.scroll(messagesContainer);
    scrollHeight = 1500;
    act(() => attachedHandlers?.onText(" while reading earlier output"));
    expect(scrollTop).toBe(180);

    act(() => {
      subscribeHandler["chat:session:updated"]?.({
        data: JSON.stringify({
          ...generatingSession,
          inFlightGeneration: { ...generatingSession.inFlightGeneration, streamingText: "working harder", replayFromEventId: 202 },
        }),
      } as MessageEvent);
    });
    expectPriorThreadVisible();

    act(() => {
      attachedHandlers?.onToolStart({ toolName: "read", args: { path: "README.md" } });
      attachedHandlers?.onText(" now");
      attachedHandlers?.onToolEnd({ toolName: "read", isError: false, result: "ok" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expectPriorThreadVisible();

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
    expectPriorThreadVisible();

    await act(async () => {
      staleFetch.resolve({ messages: [] });
      await staleFetch.promise;
    });

    expectPriorThreadVisible();
    expect(screen.getByText(/working/)).toBeInTheDocument();
  });
});

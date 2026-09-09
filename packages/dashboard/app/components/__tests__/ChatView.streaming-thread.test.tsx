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

/*
FNXC:ChatTags 2026-07-24-23:05:
useChat loads tags on mount via fetchChatTags/createChatTag/renameChatTag/deleteChatTag.
Partial ../../api factories must stub those exports or CI fails with
"No fetchChatTags export is defined on the mock" once tag APIs ship.
*/
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
  fetchChatTags: vi.fn().mockResolvedValue({ tags: [] }),
  createChatTag: vi.fn().mockResolvedValue({ tag: { id: "tag-1", name: "t", createdAt: "2026-04-08T00:00:00.000Z" } }),
  renameChatTag: vi.fn().mockResolvedValue({ tag: { id: "tag-1", name: "t", createdAt: "2026-04-08T00:00:00.000Z" } }),
  deleteChatTag: vi.fn().mockResolvedValue({ success: true }),
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
const mockCreateChatSession = vi.mocked(apiModule.createChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);
const mockCancelChatResponse = vi.mocked(apiModule.cancelChatResponse);
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

/*
FNXC:ChatNavigation 2026-08-23-23:20:
Chat opens list-first on every host (FN-054) and FN-9193 docks that list beside the thread, so a
restored session — even one that is still generating — renders as a conversation row until it is
opened. These streaming-thread invariants are about what the OPEN thread shows, so enter it first.
*/
async function openRestoredConversation() {
  const row = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(".chat-session-item");
    if (!element) throw new Error("Expected a conversation row to enter");
    return element;
  });
  await act(async () => {
    fireEvent.click(row);
  });
}

describe("FN-6599 ChatView streaming prior thread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockUseChatRooms.mockReturnValue(defaultRoomsState);
    mockGetScopedItem.mockReturnValue(undefined);
    mockSubscribeSse.mockReturnValue(() => {});
    mockFetchChatSession.mockResolvedValue({ session: makeSession({ id: "session-001", agentId: "agent-001" }) });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockCancelChatResponse.mockResolvedValue({ success: true, interrupted: false });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  });

  afterEach(() => {
    mockFetchChatSession.mockReset();
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
    await openRestoredConversation();

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
    await openRestoredConversation();
    await screen.findByText("authoritative partial response");
    firstView.unmount();

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await openRestoredConversation();
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
  ])("FN-016 keeps a direct partial reply after rendered Stop on %s", async (_label, width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    const session = makeSession({ id: "session-stop", agentId: "agent-001" });
    const interrupted = makeMessage({
      id: "assistant-interrupted",
      sessionId: session.id,
      role: "assistant",
      content: "Distinct direct stopped prefix",
      metadata: { interrupted: true },
      createdAt: "2026-08-18T21:55:00.000Z",
    });
    mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? session.id : undefined);
    mockFetchChatSessions.mockResolvedValue({ sessions: [session] });
    mockFetchChatSession.mockResolvedValue({ session });
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValue({ messages: [
        makeMessage({ id: "user-stop", sessionId: session.id, role: "user", content: "Keep this" }),
        interrupted,
      ] });
    mockCancelChatResponse.mockResolvedValue({ success: true, interrupted: true, message: interrupted });
    let streamHandlers: any;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      streamHandlers = handlers;
      return { close: vi.fn(), isConnected: () => true };
    });

    const rendered = render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await openRestoredConversation();
    const input = await screen.findByTestId("chat-input");
    fireEvent.change(input, { target: { value: "Keep this" } });
    fireEvent.click(await screen.findByTestId("chat-send-btn"));
    await waitFor(() => expect(mockStreamChatResponse).toHaveBeenCalledTimes(1));
    act(() => streamHandlers?.onText?.("Distinct direct stopped prefix"));
    await waitFor(() => expect(screen.getByText("Distinct direct stopped prefix")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("chat-stop-btn"));
    await waitFor(() => expect(mockCancelChatResponse).toHaveBeenCalledWith(session.id, "proj-123"));
    await waitFor(() => expect(screen.getAllByText("Distinct direct stopped prefix")).toHaveLength(1));
    expect(screen.getByTestId("chat-send-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-stop-btn")).not.toBeInTheDocument();

    rendered.unmount();
    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await openRestoredConversation();
    expect(await screen.findByText("Distinct direct stopped prefix")).toBeInTheDocument();
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
    await openRestoredConversation();

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

  it.each([
    ["wide", 1280],
    ["compact", 768],
    ["phone", 390],
  ])("FN-100 starts a fresh Direct thread from idle exact /new and /clear without a recovery toast on %s", async (_label, width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    const idleSession = makeSession({ id: "session-idle", agentId: "agent-001", isGenerating: false });
    const freshSessions = [
      makeSession({ id: "session-fresh-1", agentId: "agent-001", title: "Fresh one", isGenerating: false }),
      makeSession({ id: "session-fresh-2", agentId: "agent-001", title: "Fresh two", isGenerating: false }),
    ];
    const addToast = vi.fn();
    const idleCancellation = createDeferredPromise<{ success: boolean; interrupted: boolean }>();
    mockCancelChatResponse
      .mockImplementationOnce(() => idleCancellation.promise)
      .mockResolvedValue({ success: true, interrupted: false });
    mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? idleSession.id : undefined);
    mockFetchChatSessions.mockResolvedValue({ sessions: [idleSession] });
    mockFetchChatSession
      .mockResolvedValueOnce({ session: idleSession })
      .mockResolvedValueOnce({ session: freshSessions[0] })
      .mockResolvedValueOnce({ session: freshSessions[1] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockCreateChatSession
      .mockResolvedValueOnce({ session: freshSessions[0] })
      .mockResolvedValueOnce({ session: freshSessions[1] });

    render(<ChatView projectId="proj-123" addToast={addToast} />);
    fireEvent.click(await screen.findByTestId(`chat-session-${idleSession.id}`));
    const input = await screen.findByTestId("chat-input");
    fireEvent.change(input, { target: { value: "/new" } });
    fireEvent.click(screen.getByTestId("chat-send-btn"));
    await waitFor(() => expect(mockCancelChatResponse).toHaveBeenCalledWith(idleSession.id, "proj-123"));
    expect(mockCreateChatSession).not.toHaveBeenCalled();
    idleCancellation.resolve({ success: true, interrupted: false });
    await waitFor(() => expect(mockCreateChatSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: idleSession.agentId }),
      "proj-123",
    ));

    await screen.findByTestId(`chat-session-${freshSessions[0].id}`);
    const freshInput = screen.getByTestId("chat-input");
    fireEvent.change(freshInput, { target: { value: "/clear" } });
    fireEvent.click(screen.getByTestId("chat-send-btn"));
    await waitFor(() => expect(mockCreateChatSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockCancelChatResponse).toHaveBeenCalledWith(idleSession.id, "proj-123"));

    expect(mockStreamChatResponse).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalledWith(
      "Failed to save the interrupted response; it remains visible for recovery.",
      "error",
    );
    expect(mockFetchChatMessages).toHaveBeenCalledWith(freshSessions[1].id, { limit: 50, order: "desc" }, "proj-123");
  });

  it.each([
    ["desktop détaché", 1280, 300],
    ["téléphone au sommet volontaire", 390, 0],
  ])("FN-302 conserve l’ancre avant l’ajout optimiste sur %s", async (_label, width, readingTop) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    const session = makeSession({ id: `session-detached-${width}`, agentId: "agent-001" });
    const priorThread = [
      makeMessage({ id: "anchor-1", sessionId: session.id, role: "user", content: "Question ancienne" }),
      makeMessage({ id: "anchor-2", sessionId: session.id, role: "assistant", content: "Réponse ancienne" }),
      makeMessage({ id: "anchor-3", sessionId: session.id, role: "user", content: "Question récente" }),
      makeMessage({ id: "anchor-4", sessionId: session.id, role: "assistant", content: "Réponse récente" }),
    ];
    mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? session.id : undefined);
    mockFetchChatSessions.mockResolvedValue({ sessions: [session] });
    mockFetchChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: priorThread });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await openRestoredConversation();
    await screen.findByText("Réponse récente");

    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    let scrollTop = readingTop;
    Object.defineProperties(container, {
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: {
        configurable: true,
        get: () => 1200 + Math.max(0, container.querySelectorAll(".chat-message").length - priorThread.length) * 100,
      },
    });
    const offsetTopSpy = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function () {
      const messageId = this.getAttribute("data-message-id");
      const index = priorThread.findIndex((message) => message.id === messageId);
      return Math.max(0, index) * 250;
    });
    const offsetHeightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(250);

    const input = screen.getByTestId("chat-input");
    fireEvent.change(input, { target: { value: "Nouvelle question" } });
    fireEvent.click(screen.getByTestId("chat-send-btn"));

    await screen.findByText("Nouvelle question");
    expect(scrollTop).toBe(readingTop);
    offsetTopSpy.mockRestore();
    offsetHeightSpy.mockRestore();
  });

  it.each([
    ["Chat principal", 1280, {}],
    ["floating large", 1280, { floating: true }],
    ["floating étroit", 600, { floating: true }],
    ["compactLayout", 1280, { compactLayout: true }],
    ["téléphone", 390, {}],
  ])("FN-302 suit le bas pendant tout le streaming dans %s", async (_label, width, hostProps) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    const session = makeSession({ id: `session-pinned-${_label}`, agentId: "agent-001" });
    const prior = makeMessage({ id: "prior", sessionId: session.id, role: "assistant", content: "Historique" });
    let handlers: Parameters<typeof apiModule.streamChatResponse>[2] | undefined;
    let subscribeHandler: Record<string, (event: MessageEvent) => void> = {};
    mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? session.id : undefined);
    mockFetchChatSessions.mockResolvedValue({ sessions: [session] });
    mockFetchChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [prior] });
    mockStreamChatResponse.mockImplementation((_sessionId, _content, nextHandlers) => {
      handlers = nextHandlers;
      return { close: vi.fn(), isConnected: () => true };
    });
    mockSubscribeSse.mockImplementation((_url, options) => {
      subscribeHandler = options?.events as typeof subscribeHandler;
      return () => {};
    });
    const frames: FrameRequestCallback[] = [];
    const frameSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const flushFrames = () => {
      act(() => {
        for (let count = 0; count < 20 && frames.length > 0; count += 1) {
          frames.shift()?.(count);
        }
      });
    };

    render(<ChatView projectId="proj-123" addToast={vi.fn()} {...hostProps} />);
    await openRestoredConversation();
    await screen.findByText("Historique");
    flushFrames();
    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    let scrollTop = 900;
    let baseScrollHeight = 1200;
    const currentScrollHeight = () => baseScrollHeight + (container.querySelectorAll(".chat-message").length > 1 ? 100 : 0);
    Object.defineProperties(container, {
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, get: currentScrollHeight },
    });

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "Question streamée" } });
    fireEvent.click(screen.getByTestId("chat-send-btn"));
    await waitFor(() => expect(scrollTop).toBe(1300));
    flushFrames();

    act(() => {
      subscribeHandler["chat:message:added"]?.({
        data: JSON.stringify(makeMessage({
          id: "persisted-user",
          sessionId: session.id,
          role: "user",
          content: "Question streamée",
        })),
      } as MessageEvent);
    });
    await waitFor(() => expect(screen.getAllByText("Question streamée")).toHaveLength(1));
    expect(scrollTop).toBe(1300);
    flushFrames();

    baseScrollHeight = 1350;
    act(() => handlers?.onThinking?.("raisonnement"));
    flushFrames();
    await waitFor(() => expect(scrollTop).toBe(1450));
    flushFrames();

    baseScrollHeight = 1500;
    act(() => handlers?.onToolStart?.({ toolName: "read", args: { path: "README.md" } }));
    flushFrames();
    await waitFor(() => expect(scrollTop).toBe(1600));
    flushFrames();

    baseScrollHeight = 1550;
    act(() => handlers?.onText?.("réponse"));
    flushFrames();
    await waitFor(() => expect(scrollTop).toBe(1650));
    flushFrames();

    baseScrollHeight = 1600;
    act(() => handlers?.onDone?.({ messageId: "assistant-final" }));
    flushFrames();
    await waitFor(() => expect(scrollTop).toBe(1700));
    flushFrames();
    frameSpy.mockRestore();
  });

  it("FN-302 donne la priorité au scroll manuel sur une frame et un observateur déjà programmés", async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    class ControlledResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ControlledResizeObserver;
    const frames: FrameRequestCallback[] = [];
    const frameSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const flushFrames = () => {
      act(() => {
        for (let count = 0; count < 20 && frames.length > 0; count += 1) {
          frames.shift()?.(count);
        }
      });
    };
    const session = makeSession({ id: "session-manual-wins", agentId: "agent-001" });
    const prior = makeMessage({ id: "manual-prior", sessionId: session.id, role: "assistant", content: "Lecture" });
    let handlers: Parameters<typeof apiModule.streamChatResponse>[2] | undefined;
    mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? session.id : undefined);
    mockFetchChatSessions.mockResolvedValue({ sessions: [session] });
    mockFetchChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [prior] });
    mockStreamChatResponse.mockImplementation((_sessionId, _content, nextHandlers) => {
      handlers = nextHandlers;
      return { close: vi.fn(), isConnected: () => true };
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await openRestoredConversation();
    await screen.findByText("Lecture");
    flushFrames();
    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    let scrollTop = 900;
    let baseScrollHeight = 1200;
    const currentScrollHeight = () => baseScrollHeight + (container.querySelectorAll(".chat-message").length > 1 ? 100 : 0);
    Object.defineProperties(container, {
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, get: currentScrollHeight },
    });

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "Question" } });
    fireEvent.click(screen.getByTestId("chat-send-btn"));
    expect(frames.length).toBeGreaterThan(0);
    scrollTop = 280;
    fireEvent.scroll(container);
    baseScrollHeight = 1400;
    act(() => {
      handlers?.onToolStart?.({ toolName: "read", args: { path: "README.md" } });
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    });
    flushFrames();
    expect(scrollTop).toBe(280);

    scrollTop = 1200;
    fireEvent.scroll(container);
    baseScrollHeight = 1550;
    act(() => handlers?.onText?.("delta suivi"));
    flushFrames();
    await waitFor(() => expect(scrollTop).toBe(1650));

    scrollTop = 200;
    fireEvent.scroll(container);
    fireEvent.click(screen.getByTestId("chat-jump-to-latest"));
    expect(scrollTop).toBe(1650);
    frameSpy.mockRestore();
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it("FN-302 ancre le premier envoi d’une conversation vide", async () => {
    const session = makeSession({ id: "session-empty-send", agentId: "agent-001" });
    mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? session.id : undefined);
    mockFetchChatSessions.mockResolvedValue({ sessions: [session] });
    mockFetchChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await openRestoredConversation();
    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    let scrollTop = 0;
    Object.defineProperties(container, {
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, get: () => container.querySelectorAll(".chat-message").length * 100 },
    });

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "Premier message" } });
    fireEvent.click(screen.getByTestId("chat-send-btn"));
    await screen.findByText("Premier message");
    expect(scrollTop).toBe(container.scrollHeight);
  });

  it("FN-302 n’écrit aucun viewport sans session", async () => {
    mockFetchChatSessions.mockResolvedValue({ sessions: [] });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await waitFor(() => expect(screen.queryByTestId("chat-input")).not.toBeInTheDocument());
    expect(document.querySelector(".chat-messages")).toBeNull();
    expect(mockStreamChatResponse).not.toHaveBeenCalled();
  });

});

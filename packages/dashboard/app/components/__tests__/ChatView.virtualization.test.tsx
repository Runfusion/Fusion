import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { ChatView } from "../ChatView";
import { setPersistedChatOpenSession } from "../../utils/projectStorage";
import {
  activeSessionFixture,
  defaultChatState,
  installChatViewEnv,
  mockUseChat,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

const apiMocks = vi.hoisted(() => ({
  fetchChatSessions: vi.fn(),
  fetchChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  fetchChatTags: vi.fn(),
  attachChatStream: vi.fn(),
  streamChatResponse: vi.fn(),
  cancelChatResponse: vi.fn(),
}));

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn(), removeNav: vi.fn() }) };
});
vi.mock("lucide-react", async (importOriginal) => ({ ...(await importOriginal<typeof import("lucide-react")>()) }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSessions: apiMocks.fetchChatSessions,
  fetchChatSession: apiMocks.fetchChatSession,
  fetchChatMessages: apiMocks.fetchChatMessages,
  fetchChatTags: apiMocks.fetchChatTags,
  attachChatStream: apiMocks.attachChatStream,
  streamChatResponse: apiMocks.streamChatResponse,
  cancelChatResponse: apiMocks.cancelChatResponse,
}));

const actualUseChatModule = await vi.importActual<typeof import("../../hooks/useChat")>("../../hooks/useChat");

installChatViewEnv();

interface ObservedIntersection {
  callback: IntersectionObserverCallback;
  targets: Set<Element>;
}

let observedIntersections: ObservedIntersection[] = [];
class FakeIntersectionObserver {
  readonly entry: ObservedIntersection;
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, targets: new Set() };
    observedIntersections.push(this.entry);
  }
  observe = (target: Element) => { this.entry.targets.add(target); };
  unobserve = (target: Element) => { this.entry.targets.delete(target); };
  disconnect = () => { this.entry.targets.clear(); };
  takeRecords = vi.fn(() => []);
  root = null;
  rootMargin = "0px";
  thresholds = [];
}

beforeEach(() => {
  observedIntersections = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  apiMocks.fetchChatSessions.mockResolvedValue({ sessions: [activeSessionFixture] });
  apiMocks.fetchChatSession.mockResolvedValue({ session: activeSessionFixture });
  apiMocks.fetchChatTags.mockResolvedValue({ tags: [] });
  apiMocks.attachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  apiMocks.streamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  apiMocks.cancelChatResponse.mockResolvedValue({ success: true });
});
afterEach(() => vi.unstubAllGlobals());

const messages = Array.from({ length: 1_000 }, (_, index) => ({
  id: `message-${String(index).padStart(4, "0")}`,
  sessionId: activeSessionFixture.id,
  role: index % 2 ? "assistant" as const : "user" as const,
  content: `Rich markdown message ${index}\n\n- item`,
  thinkingOutput: index % 3 === 0 ? `Thinking ${index}` : null,
  metadata: index % 5 === 0 ? { toolCalls: [{ name: "read", status: "completed", result: "ok" }] } : null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function makeSessionMessages(sessionId: string, prefix: string, count = 200) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(3, "0")}`,
    sessionId,
    role: index % 2 ? "assistant" as const : "user" as const,
    content: `${prefix} message ${index}`,
    thinkingOutput: null,
    metadata: null,
    createdAt: new Date(Date.UTC(2026, 8, 7, 20, 0, index)).toISOString(),
  }));
}

function installOpeningGeometry(transcript: HTMLElement, latestMessageId: string, initialScrollHeight: number) {
  let scrollTop = 0;
  let scrollHeight = initialScrollHeight;
  Object.defineProperties(transcript, {
    clientHeight: { configurable: true, value: 320 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        // Model the browser mount clamp: the DOM cannot reach the tail before the terminal virtual window exists.
        if (document.querySelector(`[data-message-id="${latestMessageId}"]`)) scrollTop = value;
      },
    },
  });
  return {
    get scrollTop() { return scrollTop; },
    setManualScrollTop(value: number) { scrollTop = value; },
    setScrollHeight(value: number) { scrollHeight = value; },
  };
}

function installTrackedResizeObserver() {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
  class TrackedResizeObserver {
    readonly entry: { callback: ResizeObserverCallback; targets: Set<Element> };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set() };
      observers.push(this.entry);
    }
    observe = (target: Element) => { this.entry.targets.add(target); };
    unobserve = (target: Element) => { this.entry.targets.delete(target); };
    disconnect = () => { this.entry.targets.clear(); };
  }
  vi.stubGlobal("ResizeObserver", TrackedResizeObserver);
  return (target: Element, blockSize?: number) => {
    for (const observer of observers) {
      if (!observer.targets.has(target)) continue;
      observer.callback([{
        target,
        borderBoxSize: blockSize === undefined ? undefined : [{ blockSize }],
        contentRect: { height: blockSize ?? 0 },
      } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    }
  };
}

function installPagedDirectChat(session = activeSessionFixture) {
  const cursors: string[] = [];
  mockUseChat.mockImplementation(() => {
    const [loadedMessages, setLoadedMessages] = useState(messages.slice(-50));
    const [hasMoreMessages, setHasMoreMessages] = useState(true);
    return {
      ...defaultChatState,
      activeSession: session,
      sessions: [session],
      filteredSessions: [session],
      messages: loadedMessages,
      hasMoreMessages,
      loadMoreMessages: async () => {
        setLoadedMessages((current) => {
          const beforeId = current[0]?.id;
          if (!beforeId) return current;
          cursors.push(beforeId);
          const end = messages.findIndex((message) => message.id === beforeId);
          const page = messages.slice(Math.max(0, end - 50), end);
          const merged = [...page, ...current];
          setHasMoreMessages(merged.length < messages.length);
          return merged;
        });
      },
    };
  });
  return cursors;
}

function installPagedStreamingDirectChat() {
  const cursors: string[] = [];
  let publishStream: ((next: { text: string; thinking: string; toolCalls: typeof defaultChatState.streamingToolCalls }) => void) | undefined;
  mockUseChat.mockImplementation(() => {
    const [loadedMessages, setLoadedMessages] = useState(messages.slice(-50));
    const [hasMoreMessages, setHasMoreMessages] = useState(true);
    const [stream, setStream] = useState({ text: "", thinking: "", toolCalls: [] as typeof defaultChatState.streamingToolCalls });
    publishStream = setStream;
    return {
      ...defaultChatState,
      activeSession: activeSessionFixture,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      messages: loadedMessages,
      hasMoreMessages,
      isStreaming: true,
      streamingText: stream.text,
      streamingThinking: stream.thinking,
      streamingToolCalls: stream.toolCalls,
      loadMoreMessages: async () => {
        setLoadedMessages((current) => {
          const beforeId = current[0]?.id;
          if (!beforeId) return current;
          cursors.push(beforeId);
          const end = messages.findIndex((message) => message.id === beforeId);
          const page = messages.slice(Math.max(0, end - 50), end);
          const merged = [...page, ...current];
          setHasMoreMessages(merged.length < messages.length);
          return merged;
        });
      },
    };
  });
  return {
    cursors,
    publishStream(next: { text: string; thinking: string; toolCalls: typeof defaultChatState.streamingToolCalls }) {
      if (!publishStream) throw new Error("Direct Chat stream fixture is not mounted");
      publishStream(next);
    },
  };
}

async function loadNextDirectPage(cursors: readonly string[], expectedCursorCount: number) {
  const observer = [...observedIntersections].reverse().find((entry) =>
    [...entry.targets].some((target) => target.classList.contains("chat-load-more-sentinel")));
  expect(observer).toBeDefined();
  await act(async () => {
    observer?.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
  await waitFor(() => expect(cursors).toHaveLength(expectedCursorCount));
}

/*
FNXC:ChatTranscriptVirtualization 2026-09-06-14:31:
The shared Direct Chat pane is exercised through its production history sentinel, one strict 50-row page at a time, before DOM bounds are asserted across provider, CLI, desktop, mobile, floating, and dock hosts. Search, scroll, and text/thinking/tool-call stream growth navigate or extend virtual keys after pagination instead of relying on an injected complete array; pinned readers follow the synthetic tail while detached readers retain their position.
*/
describe("ChatView transcript virtualization", () => {
  /*
  FNXC:ChatScrollAnchor 2026-09-07-23:34:
  La preuve de restauration doit traverser le vrai useChat et ses requêtes différées: les hôtes ordinaires restaurent la préférence projet, tandis que les hôtes secondaires restaurent leur session explicite. Chaque chemin sélectionne ensuite un autre fil par l’interface, afin que la fenêtre virtualisée terminale, le viewport et l’abandon au premier scroll manuel soient vérifiés comme un seul contrat de production.
  */
  it.each([
    ["provider desktop", "desktop", false, false, false],
    ["provider mobile", "mobile", false, false, false],
    ["provider detached", "desktop", true, false, true],
    ["CLI floating", "desktop", true, false, true],
    ["CLI dock", "desktop", false, true, true],
  ] as const)("restaure puis sélectionne un long fil à sa fin réelle dans l’hôte %s", async (_name, viewport, floating, compactLayout, cli) => {
    mockViewportMode(viewport);
    mockUseChat.mockImplementation(actualUseChatModule.useChat);
    setupMockRooms();

    const restoredSession = {
      ...activeSessionFixture,
      id: `restored-${cli ? "cli" : "provider"}`,
      title: "Conversation restaurée",
      ...(cli ? { cliExecutorAdapterId: "claude" } : {}),
    };
    const selectedSession = {
      ...restoredSession,
      id: `selected-${cli ? "cli" : "provider"}`,
      title: "Conversation sélectionnée",
    };
    const restoredMessages = makeSessionMessages(restoredSession.id, "restored");
    const selectedMessages = makeSessionMessages(selectedSession.id, "selected");
    const restoredRequest = deferred<{ messages: typeof restoredMessages }>();
    const selectedRequest = deferred<{ messages: typeof selectedMessages }>();
    const fireTranscriptResize = installTrackedResizeObserver();
    const queuedFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });

    apiMocks.fetchChatSessions.mockResolvedValue({ sessions: [restoredSession, selectedSession] });
    apiMocks.fetchChatSession.mockImplementation(async (sessionId: string) => ({
      session: { ...(sessionId === restoredSession.id ? restoredSession : selectedSession), isGenerating: false },
    }));
    apiMocks.fetchChatMessages.mockImplementation((sessionId: string) => {
      if (sessionId === restoredSession.id) return restoredRequest.promise;
      if (sessionId === selectedSession.id) return selectedRequest.promise;
      throw new Error(`Unexpected session ${sessionId}`);
    });

    const usesExplicitRestoration = floating || compactLayout;
    if (!usesExplicitRestoration) setPersistedChatOpenSession(restoredSession.id, "project");
    await renderWithAct(
      <ChatView
        projectId="project"
        addToast={vi.fn()}
        floating={floating}
        compactLayout={compactLayout}
        initialDirectSession={usesExplicitRestoration ? restoredSession : undefined}
        persistChatPreferences={!usesExplicitRestoration}
      />,
    );

    await waitFor(() => expect(apiMocks.fetchChatMessages).toHaveBeenCalledWith(
      restoredSession.id,
      expect.objectContaining({ limit: 50, order: "desc" }),
      "project",
    ));
    const restoredTranscript = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".chat-messages");
      expect(element).not.toBeNull();
      return element!;
    });
    const restoredLatestId = restoredMessages.at(-1)!.id;
    const restoredGeometry = installOpeningGeometry(restoredTranscript, restoredLatestId, restoredMessages.length * 112);
    await act(async () => { restoredRequest.resolve({ messages: [...restoredMessages].reverse() }); });
    await waitFor(() => expect(document.querySelector(`[data-message-id="${restoredLatestId}"]`)).toBeInTheDocument());
    act(() => {
      let frame = queuedFrames.shift();
      while (frame) {
        frame(0);
        frame = queuedFrames.shift();
      }
    });
    await waitFor(() => expect(restoredGeometry.scrollTop + restoredTranscript.clientHeight).toBeGreaterThanOrEqual(restoredTranscript.scrollHeight));
    expect(document.querySelectorAll(".chat-message").length).toBeLessThanOrEqual(60);

    const backButton = screen.queryByTestId("chat-back-btn");
    if (backButton) fireEvent.click(backButton);
    fireEvent.click(await screen.findByTestId(`chat-session-${selectedSession.id}`));
    await waitFor(() => expect(apiMocks.fetchChatMessages).toHaveBeenCalledWith(
      selectedSession.id,
      expect.objectContaining({ limit: 50, order: "desc" }),
      "project",
    ));
    const selectedTranscript = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".chat-messages");
      expect(element).not.toBeNull();
      return element!;
    });
    const selectedLatestId = selectedMessages.at(-1)!.id;
    const selectedGeometry = installOpeningGeometry(selectedTranscript, selectedLatestId, selectedMessages.length * 112);
    await act(async () => { selectedRequest.resolve({ messages: [...selectedMessages].reverse() }); });
    await waitFor(() => expect(document.querySelector(`[data-message-id="${selectedLatestId}"]`)).toBeInTheDocument());
    act(() => {
      let frame = queuedFrames.shift();
      while (frame) {
        frame(0);
        frame = queuedFrames.shift();
      }
    });
    await waitFor(() => expect(selectedGeometry.scrollTop + selectedTranscript.clientHeight).toBeGreaterThanOrEqual(selectedTranscript.scrollHeight));

    const selectedLatestRow = document.querySelector(`[data-message-id="${selectedLatestId}"]`)?.closest(".chat-transcript-row");
    expect(selectedLatestRow).not.toBeNull();
    selectedGeometry.setScrollHeight((selectedMessages.length * 112) + 488);
    act(() => fireTranscriptResize(selectedLatestRow!, 600));
    await waitFor(() => expect(document.querySelector(`[data-message-id="${selectedLatestId}"]`)).toBeInTheDocument());
    await waitFor(() => expect(selectedGeometry.scrollTop + selectedTranscript.clientHeight).toBeGreaterThanOrEqual(selectedTranscript.scrollHeight));

    selectedGeometry.setManualScrollTop(120);
    act(() => fireEvent.scroll(selectedTranscript));
    selectedGeometry.setScrollHeight((selectedMessages.length * 112) + 588);
    act(() => {
      const latestRowAfterDetach = document.querySelector(`[data-message-id="${selectedLatestId}"]`)?.closest(".chat-transcript-row");
      expect(latestRowAfterDetach).not.toBeNull();
      fireTranscriptResize(latestRowAfterDetach!, 700);
      fireTranscriptResize(selectedTranscript);
      let frame = queuedFrames.shift();
      while (frame) {
        frame(0);
        frame = queuedFrames.shift();
      }
    });
    expect(selectedGeometry.scrollTop).toBe(120);
  });

  it.each([
    ["provider desktop", "desktop", activeSessionFixture, {}],
    ["provider mobile", "mobile", activeSessionFixture, {}],
    ["CLI floating", "desktop", { ...activeSessionFixture, cliExecutorAdapterId: "claude" }, { floating: true }],
    ["CLI dock", "desktop", { ...activeSessionFixture, cliExecutorAdapterId: "claude" }, { compactLayout: true }],
  ] as const)("paginates and bounds 1,000 rich messages in the %s host", async (_name, viewport, session, props) => {
    mockViewportMode(viewport);
    setupMockRooms();
    const cursors = installPagedDirectChat(session);
    await renderWithAct(<ChatView projectId="project" addToast={vi.fn()} initialDirectSession={session} {...props} />);

    const transcript = document.querySelector<HTMLElement>(".chat-messages")!;
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: viewport === "mobile" ? 360 : 720 },
      scrollHeight: { configurable: true, value: 112_000 },
      scrollTop: { configurable: true, writable: true, value: 111_280 },
    });
    act(() => fireEvent.scroll(transcript));
    for (let page = 1; page < 20; page += 1) await loadNextDirectPage(cursors, page);

    expect(cursors).toHaveLength(19);
    expect(cursors[0]).toBe("message-0950");
    expect(cursors.at(-1)).toBe("message-0050");
    expect(document.querySelectorAll(".chat-message").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".chat-message").length).toBeLessThanOrEqual(60);
    expect(document.querySelectorAll(".chat-transcript-spacer[aria-hidden='true']").length).toBeGreaterThan(0);
    if (session.cliExecutorAdapterId) expect(document.querySelector(".cli-chat-surface[data-view='transcript']")).toBeInTheDocument();
  });

  it("parcourt les 1 000 lignes via le vrai useChat et ses curseurs composés", async () => {
    mockUseChat.mockImplementation(actualUseChatModule.useChat);
    apiMocks.fetchChatMessages.mockImplementation(async (_sessionId: string, options?: { beforeId?: string }) => {
      const end = options?.beforeId ? messages.findIndex((message) => message.id === options.beforeId) : messages.length;
      return { messages: messages.slice(Math.max(0, end - 50), end).reverse() };
    });
    setupMockRooms();
    setPersistedChatOpenSession(activeSessionFixture.id, "project");
    await renderWithAct(<ChatView projectId="project" addToast={vi.fn()} />);
    await waitFor(() => expect(apiMocks.fetchChatMessages).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Rich markdown message 999")).toBeInTheDocument();

    for (let page = 1; page < 20; page += 1) {
      const observer = [...observedIntersections].reverse().find((entry) =>
        [...entry.targets].some((target) => target.classList.contains("chat-load-more-sentinel")));
      expect(observer).toBeDefined();
      await act(async () => {
        observer?.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      await waitFor(() => expect(apiMocks.fetchChatMessages).toHaveBeenCalledTimes(page + 1));
    }

    const paginationOptions = apiMocks.fetchChatMessages.mock.calls.slice(1).map((call) => call[1]);
    expect(paginationOptions[0]).toMatchObject({ beforeId: "message-0950", before: messages[950]!.createdAt });
    expect(paginationOptions.at(-1)).toMatchObject({ beforeId: "message-0050", before: messages[50]!.createdAt });
    expect(new Set(paginationOptions.map((options) => options?.beforeId)).size).toBe(19);

    const transcript = document.querySelector<HTMLElement>(".chat-messages")!;
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 720 },
      scrollHeight: { configurable: true, value: 112_000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    const visited = new Set<string>();
    for (let scrollTop = 0; scrollTop <= 111_280; scrollTop += 560) {
      transcript.scrollTop = scrollTop;
      act(() => fireEvent.scroll(transcript));
      for (const element of document.querySelectorAll<HTMLElement>(".chat-message[data-message-id]")) {
        if (element.dataset.messageId) visited.add(element.dataset.messageId);
      }
    }
    transcript.scrollTop = 111_280;
    act(() => fireEvent.scroll(transcript));
    for (const element of document.querySelectorAll<HTMLElement>(".chat-message[data-message-id]")) {
      if (element.dataset.messageId) visited.add(element.dataset.messageId);
    }
    expect(visited).toEqual(new Set(messages.map((message) => message.id)));
    expect(document.querySelectorAll(".chat-message").length).toBeLessThanOrEqual(60);
  });

  it("laisse le virtualiseur préserver seul l’ancre détachée lors d’un préfixage", async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) { intersectionCallback = callback; }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
      root = null;
      rootMargin = "0px";
      thresholds = [];
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const initialPage = messages.slice(-50);
    const olderPage = messages.slice(-100, -50);
    mockUseChat.mockImplementation(() => {
      const [loadedMessages, setLoadedMessages] = useState(initialPage);
      const [hasMoreMessages, setHasMoreMessages] = useState(true);
      return {
        ...defaultChatState,
        activeSession: activeSessionFixture,
        sessions: [activeSessionFixture],
        filteredSessions: [activeSessionFixture],
        messages: loadedMessages,
        hasMoreMessages,
        loadMoreMessages: async () => {
          setLoadedMessages((current) => [...olderPage, ...current]);
          setHasMoreMessages(false);
        },
      };
    });
    setupMockRooms();
    await renderWithAct(<ChatView projectId="project" addToast={vi.fn()} initialDirectSession={activeSessionFixture} />);

    const transcript = document.querySelector<HTMLElement>(".chat-messages")!;
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 5_600 },
      scrollTop: { configurable: true, writable: true, value: 1_120 },
    });
    for (const row of document.querySelectorAll<HTMLElement>(".chat-message[data-message-id]")) {
      const index = initialPage.findIndex((message) => message.id === row.dataset.messageId);
      Object.defineProperties(row, {
        offsetTop: { configurable: true, value: Math.max(0, index) * 112 },
        offsetHeight: { configurable: true, value: 112 },
      });
    }
    act(() => fireEvent.scroll(transcript));

    act(() => intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(transcript.scrollTop).toBe(6_720));
    expect(document.querySelectorAll(".chat-message").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".chat-message").length).toBeLessThanOrEqual(60);
  });

  it("borne le streaming riche après 1 000 messages paginés, épinglé puis détaché", async () => {
    setupMockRooms();
    const stream = installPagedStreamingDirectChat();
    await renderWithAct(<ChatView projectId="project" addToast={vi.fn()} initialDirectSession={activeSessionFixture} />);
    const transcript = document.querySelector<HTMLElement>(".chat-messages")!;
    let scrollTop = 111_280;
    let scrollHeight = 112_000;
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 720 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
    });
    act(() => fireEvent.scroll(transcript));
    for (let page = 1; page < 20; page += 1) await loadNextDirectPage(stream.cursors, page);

    const expectBounded = () => expect(document.querySelectorAll(".chat-message").length).toBeLessThanOrEqual(60);
    scrollHeight = 112_200;
    act(() => stream.publishStream({ text: "Réponse massive en cours", thinking: "", toolCalls: [] }));
    await waitFor(() => expect(scrollTop).toBe(scrollHeight));
    expect(await screen.findByText("Réponse massive en cours")).toBeInTheDocument();
    expectBounded();

    scrollHeight = 112_300;
    act(() => stream.publishStream({ text: "Réponse massive en cours", thinking: "Raisonnement massif", toolCalls: [] }));
    await waitFor(() => expect(scrollTop).toBe(scrollHeight));
    expect(await screen.findByText("Raisonnement massif")).toBeInTheDocument();
    expectBounded();

    scrollHeight = 112_400;
    act(() => stream.publishStream({
      text: "Réponse massive en cours",
      thinking: "Raisonnement massif",
      toolCalls: [{ toolName: "massive_stream_tool", status: "running", isError: false, args: { path: "PROMPT.md" } }],
    }));
    await waitFor(() => expect(scrollTop).toBe(scrollHeight));
    expect(document.body.textContent).toContain("massive_stream_tool");
    expectBounded();

    scrollTop = 24_000;
    act(() => fireEvent.scroll(transcript));
    for (const [height, next] of [
      [112_600, { text: "Réponse massive détachée", thinking: "Raisonnement massif", toolCalls: [] }],
      [112_700, { text: "Réponse massive détachée", thinking: "Raisonnement détaché", toolCalls: [] }],
      [112_800, { text: "Réponse massive détachée", thinking: "Raisonnement détaché", toolCalls: [{ toolName: "detached_stream_tool", status: "completed" as const, isError: false, result: "ok" }] }],
    ] as const) {
      scrollHeight = height;
      act(() => stream.publishStream(next));
      await waitFor(() => expect(document.querySelectorAll(".chat-message").length).toBeGreaterThan(0));
      expect(scrollTop).toBe(24_000);
      expectBounded();
    }
  });

  it("keeps an off-window search result centered through a late row measurement", async () => {
    mockViewportMode("desktop");
    setupMockRooms();
    const fireTranscriptResize = installTrackedResizeObserver();
    const cursors = installPagedDirectChat();
    await renderWithAct(<ChatView projectId="project" addToast={vi.fn()} initialDirectSession={activeSessionFixture} />);
    for (let page = 1; page < 20; page += 1) await loadNextDirectPage(cursors, page);

    const transcript = document.querySelector<HTMLElement>(".chat-messages")!;
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 112_000 },
      scrollTop: { configurable: true, writable: true, value: 111_600 },
    });
    const findEvent = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    transcript.dispatchEvent(findEvent);
    const search = await screen.findByTestId("chat-conversation-search-input");
    fireEvent.change(search, { target: { value: "Rich markdown message 10" } });
    const resultMessage = await screen.findByText("Rich markdown message 10", { exact: false });
    await waitFor(() => expect(transcript.scrollTop).toBeLessThan(2_000));
    const centeredScrollTop = transcript.scrollTop;
    expect(centeredScrollTop).toBeGreaterThan(0);

    const resultRow = resultMessage.closest(".chat-transcript-row");
    expect(resultRow).not.toBeNull();
    act(() => fireTranscriptResize(resultRow!, 212));

    expect(transcript.scrollTop).toBe(centeredScrollTop);
    expect(transcript.scrollTop + transcript.clientHeight).toBeLessThan(transcript.scrollHeight);
    expect(document.querySelectorAll(".chat-message").length).toBeLessThanOrEqual(60);
  });
});

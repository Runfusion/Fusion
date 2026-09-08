import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import type { ChatMessageInfo, ChatSessionInfo } from "../../hooks/useChat";
import {
  activeSessionFixture,
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), removeNav: vi.fn() }),
  };
});
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: "", defaultModelId: "" }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();
afterEach(() => cleanup());

function message(id: string, content: string): ChatMessageInfo {
  return {
    id,
    sessionId: activeSessionFixture.id,
    role: "assistant",
    content,
    createdAt: `2026-09-07T21:3${id === "message-old" ? "0" : "1"}:00.000Z`,
  };
}

function installTranscriptGeometry(transcript: HTMLElement, initialHeight = 1_200) {
  let scrollTop = 0;
  let scrollHeight = initialHeight;
  Object.defineProperties(transcript, {
    clientHeight: { configurable: true, value: 320 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    },
  });
  return {
    get scrollTop() { return scrollTop; },
    setScrollTop(value: number) { scrollTop = value; },
    setScrollHeight(value: number) { scrollHeight = value; },
  };
}

function installSessionListGeometry(list: HTMLElement, initialScrollTop = 0) {
  let scrollTop = initialScrollTop;
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 320 },
    scrollHeight: { configurable: true, value: 7_600 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    },
  });
  return {
    get scrollTop() { return scrollTop; },
    setScrollTop(value: number) { scrollTop = value; },
  };
}

function conversationSessions(count: number, options: { cli?: boolean; prefix?: string } = {}): ChatSessionInfo[] {
  const prefix = options.prefix ?? "conversation";
  return Array.from({ length: count }, (_, index) => ({
    ...activeSessionFixture,
    id: index === 0 ? activeSessionFixture.id : `${prefix}-${String(index).padStart(3, "0")}`,
    title: index === 0 ? "Première conversation" : index === count - 1 ? "Dernière conversation" : `Conversation ${index}`,
    updatedAt: `2026-09-08T19:${String(index % 60).padStart(2, "0")}:00.000Z`,
    ...(options.cli ? { cliExecutorAdapterId: "claude" } : {}),
  }));
}

const oldMessage = message("message-old", "Message précédent");
const latestMessage = message("message-latest", "Dernier message restauré");

/*
FNXC:ChatScrollAnchor 2026-09-07-22:17:
FN-313 traite chaque ouverture de fil comme une nouvelle propriété du viewport: après le montage list-first, un changement depuis un fil détaché ou le chargement asynchrone de la transcription, chaque hôte partagé se stabilise sur la hauteur courante. Un défilement manuel ne protège que l’incarnation du fil où il a eu lieu.
*/
const chatHostCases = [
  ["provider desktop", "desktop", activeSessionFixture, {}],
  ["provider mobile", "mobile", activeSessionFixture, {}],
  ["provider detached", "desktop", activeSessionFixture, { floating: true }],
  ["CLI floating", "desktop", { ...activeSessionFixture, cliExecutorAdapterId: "claude" }, { floating: true }],
  ["CLI dock", "desktop", { ...activeSessionFixture, cliExecutorAdapterId: "claude" }, { compactLayout: true }],
] as const;

/*
FNXC:ChatScrollAnchor 2026-09-08-20:49:
FN-316 exige que tous les hôtes partagés ouvrent une longue liste directe sur sa première fenêtre, sans transmettre l’alignement terminal réservé au transcript. Les changements de collection peuvent repartir en tête, mais l’ouverture et la fermeture d’un fil doivent conserver la position manuelle de la liste.
*/
const conversationListHostCases = [
  ["provider desktop", "desktop", false, {}],
  ["provider tablet", "tablet", false, {}],
  ["provider mobile", "mobile", false, {}],
  ["provider detached", "desktop", false, { floating: true }],
  ["CLI floating", "desktop", true, { floating: true }],
  ["CLI dock", "desktop", true, { compactLayout: true }],
] as const;

describe("ChatView keeps conversation-list scrolling independent", () => {
  it.each(conversationListHostCases)("opens the long %s list at its first virtual window", async (_name, viewport, cli, hostProps) => {
    mockViewportMode(viewport);
    const sessions = conversationSessions(100, { cli });
    setupMockChat({ activeSession: null, sessions, filteredSessions: sessions, messages: [] });

    await renderWithAct(<ChatView projectId="project" addToast={vi.fn()} {...hostProps} />);

    const list = document.querySelector<HTMLElement>(".chat-session-list")!;
    expect(list.scrollTop).toBe(0);
    expect(screen.getByTestId(`chat-session-${sessions[0]!.id}`)).toHaveTextContent("Première conversation");
    expect(screen.queryByTestId(`chat-session-${sessions.at(-1)!.id}`)).not.toBeInTheDocument();
  });

  it.each([
    ["provider mobile", "mobile", false, {}],
    ["provider docked", "desktop", false, {}],
    ["CLI floating", "desktop", true, { floating: true }],
    ["CLI dock", "desktop", true, { compactLayout: true }],
  ] as const)("preserves the %s list while delayed messages anchor only the transcript", async (_name, viewport, cli, hostProps) => {
    mockViewportMode(viewport);
    const sessions = conversationSessions(100, { cli });
    const selectSession = vi.fn();
    setupMockChat({ activeSession: null, sessions, filteredSessions: sessions, messages: [], selectSession });
    const view = await renderWithAct(<ChatView projectId="project" addToast={vi.fn()} {...hostProps} />);
    const list = document.querySelector<HTMLElement>(".chat-session-list")!;
    const listGeometry = installSessionListGeometry(list);
    listGeometry.setScrollTop(640);
    act(() => fireEvent.scroll(list));

    const selectedSession = sessions[8]!;
    fireEvent.click(screen.getByTestId(`chat-session-${selectedSession.id}`));
    expect(selectSession).toHaveBeenCalledWith(selectedSession.id);
    setupMockChat({ activeSession: selectedSession, sessions, filteredSessions: sessions, messages: [oldMessage], messagesLoading: true, selectSession });
    view.rerender(<ChatView projectId="project" addToast={vi.fn()} {...hostProps} />);

    const transcript = document.querySelector<HTMLElement>(".chat-messages")!;
    const transcriptGeometry = installTranscriptGeometry(transcript, 1_200);
    transcriptGeometry.setScrollHeight(1_600);
    setupMockChat({ activeSession: selectedSession, sessions, filteredSessions: sessions, messages: [oldMessage, latestMessage], messagesLoading: false, selectSession });
    view.rerender(<ChatView projectId="project" addToast={vi.fn()} {...hostProps} />);

    expect(await screen.findByText(latestMessage.content)).toBeInTheDocument();
    await waitFor(() => expect(transcriptGeometry.scrollTop).toBe(1_600));
    expect(listGeometry.scrollTop).toBe(640);

    const back = screen.queryByTestId("chat-back-btn");
    if (back) {
      fireEvent.click(back);
      expect(listGeometry.scrollTop).toBe(640);
      expect(screen.getByTestId(`chat-session-${selectedSession.id}`)).toBeInTheDocument();
    }
  });

  it("starts each active, searched, tagged, and archived collection at the beginning", async () => {
    const active = conversationSessions(100);
    const searched = conversationSessions(100, { prefix: "searched" });
    const tagged = conversationSessions(100, { prefix: "tagged" });
    const archived = conversationSessions(100, { prefix: "archived" });
    setupMockChat({ activeSession: null, sessions: active, filteredSessions: active, messages: [] });
    const view = await renderWithAct(<ChatView projectId="project" addToast={vi.fn()} />);
    const list = document.querySelector<HTMLElement>(".chat-session-list")!;
    const geometry = installSessionListGeometry(list, 500);

    setupMockChat({ activeSession: null, sessions: active, filteredSessions: searched, searchQuery: "needle", messages: [] });
    view.rerender(<ChatView projectId="project" addToast={vi.fn()} />);
    expect(geometry.scrollTop).toBe(0);
    expect(screen.getByText("Première conversation")).toBeInTheDocument();

    geometry.setScrollTop(500);
    setupMockChat({ activeSession: null, sessions: active, filteredSessions: tagged, selectedTagId: "tag-1", messages: [] });
    view.rerender(<ChatView projectId="project" addToast={vi.fn()} />);
    expect(geometry.scrollTop).toBe(0);

    geometry.setScrollTop(500);
    setupMockChat({ activeSession: null, sessions: active, filteredSessions: tagged, selectedTagId: "tag-1", archivedSessions: archived, messages: [] });
    fireEvent.click(screen.getByTestId("chat-archived-toggle"));
    expect(geometry.scrollTop).toBe(0);
    expect(screen.getByTestId(`chat-archived-session-${archived[0]!.id}`)).toHaveTextContent("Première conversation");
  });

  it("keeps empty, small, and defensively duplicated inputs at the list start", async () => {
    const small = conversationSessions(3);
    setupMockChat({ activeSession: null, sessions: small, filteredSessions: small, messages: [] });
    const view = await renderWithAct(<ChatView projectId="project" addToast={vi.fn()} />);
    const list = document.querySelector<HTMLElement>(".chat-session-list")!;
    expect(list.scrollTop).toBe(0);
    expect(screen.getByText("Première conversation")).toBeInTheDocument();
    expect(screen.getByText("Dernière conversation")).toBeInTheDocument();

    const long = conversationSessions(100);
    const duplicatedSession = { ...long[1]!, title: "Conversation dupliquée" };
    const duplicateInput = [...long.slice(0, 2), duplicatedSession, ...long.slice(2)];
    setupMockChat({ activeSession: null, sessions: duplicateInput, filteredSessions: duplicateInput, messages: [] });
    view.rerender(<ChatView projectId="project" addToast={vi.fn()} />);
    expect(list.scrollTop).toBe(0);
    expect(screen.getByTestId(`chat-session-${long[0]!.id}`)).toHaveTextContent("Première conversation");
    expect(screen.getAllByTestId(`chat-session-${duplicatedSession.id}`)).toHaveLength(2);
    expect(screen.queryByTestId(`chat-session-${long.at(-1)!.id}`)).not.toBeInTheDocument();

    setupMockChat({ activeSession: null, sessions: [], filteredSessions: [], messages: [] });
    view.rerender(<ChatView projectId="project" addToast={vi.fn()} />);
    expect(list.scrollTop).toBe(0);
    expect(screen.getByText("No conversations yet")).toBeInTheDocument();
    expect(document.querySelector(".chat-messages")).toBeNull();
  });
});

describe("ChatView opens conversations at the latest message", () => {
  it.each(chatHostCases)("anchors delayed transcript rendering in the %s host", async (_name, viewport, session, hostProps) => {
    mockViewportMode(viewport);
    setupMockChat({
      activeSession: session as ChatSessionInfo,
      sessions: [session as ChatSessionInfo],
      filteredSessions: [session as ChatSessionInfo],
      messages: [oldMessage],
      messagesLoading: true,
    });
    const view = await renderWithAct(
      <ChatView projectId="project" addToast={vi.fn()} initialDirectSession={session as ChatSessionInfo} {...hostProps} />,
    );
    const transcript = document.querySelector<HTMLElement>(".chat-messages");
    expect(transcript).not.toBeNull();
    const geometry = installTranscriptGeometry(transcript!);

    geometry.setScrollHeight(1_600);
    setupMockChat({
      activeSession: session as ChatSessionInfo,
      sessions: [session as ChatSessionInfo],
      filteredSessions: [session as ChatSessionInfo],
      messages: [oldMessage, latestMessage],
      messagesLoading: false,
    });
    view.rerender(
      <ChatView projectId="project" addToast={vi.fn()} initialDirectSession={session as ChatSessionInfo} {...hostProps} />,
    );

    expect(await screen.findByText(latestMessage.content)).toBeInTheDocument();
    await waitFor(() => expect(geometry.scrollTop).toBe(1_600));
  });

  it.each(chatHostCases)("resets the previous thread's manual-scroll ownership before delayed messages reach the %s host", async (_name, viewport, session, hostProps) => {
    mockViewportMode(viewport);
    const nextSession = { ...session, id: `${session.id}-next`, title: "Fil suivant" } as ChatSessionInfo;
    setupMockChat({
      activeSession: session as ChatSessionInfo,
      sessions: [session as ChatSessionInfo, nextSession],
      filteredSessions: [session as ChatSessionInfo, nextSession],
      messages: [oldMessage, latestMessage],
      messagesLoading: false,
    });
    const view = await renderWithAct(
      <ChatView projectId="project" addToast={vi.fn()} initialDirectSession={session as ChatSessionInfo} {...hostProps} />,
    );
    const transcript = document.querySelector<HTMLElement>(".chat-messages")!;
    const geometry = installTranscriptGeometry(transcript, 1_600);
    geometry.setScrollTop(120);
    act(() => fireEvent.scroll(transcript));

    geometry.setScrollHeight(1_700);
    setupMockChat({
      activeSession: nextSession,
      sessions: [session as ChatSessionInfo, nextSession],
      filteredSessions: [session as ChatSessionInfo, nextSession],
      messages: [],
      messagesLoading: true,
    });
    view.rerender(
      <ChatView projectId="project" addToast={vi.fn()} initialDirectSession={nextSession} {...hostProps} />,
    );
    await waitFor(() => expect(geometry.scrollTop).toBe(1_700));

    const nextLatestMessage = { ...latestMessage, id: "message-next-latest", sessionId: nextSession.id, content: "Dernier message du fil suivant" };
    geometry.setScrollHeight(2_000);
    setupMockChat({
      activeSession: nextSession,
      sessions: [session as ChatSessionInfo, nextSession],
      filteredSessions: [session as ChatSessionInfo, nextSession],
      messages: [nextLatestMessage],
      messagesLoading: false,
    });
    view.rerender(
      <ChatView projectId="project" addToast={vi.fn()} initialDirectSession={nextSession} {...hostProps} />,
    );

    expect(await screen.findByText(nextLatestMessage.content)).toBeInTheDocument();
    await waitFor(() => expect(geometry.scrollTop).toBe(2_000));
  });

  it.each(chatHostCases)("does not retake the %s viewport when cached-message loading finishes after a manual scroll", async (_name, viewport, session, hostProps) => {
    mockViewportMode(viewport);
    setupMockChat({
      activeSession: session as ChatSessionInfo,
      sessions: [session as ChatSessionInfo],
      filteredSessions: [session as ChatSessionInfo],
      messages: [oldMessage, latestMessage],
      messagesLoading: true,
    });
    const view = await renderWithAct(
      <ChatView projectId="project" addToast={vi.fn()} initialDirectSession={session as ChatSessionInfo} {...hostProps} />,
    );
    const transcript = document.querySelector<HTMLElement>(".chat-messages")!;
    const geometry = installTranscriptGeometry(transcript, 1_600);

    geometry.setScrollTop(1_600);
    geometry.setScrollTop(120);
    act(() => fireEvent.scroll(transcript));

    setupMockChat({
      activeSession: session as ChatSessionInfo,
      sessions: [session as ChatSessionInfo],
      filteredSessions: [session as ChatSessionInfo],
      messages: [oldMessage, latestMessage],
      messagesLoading: false,
    });
    view.rerender(
      <ChatView projectId="project" addToast={vi.fn()} initialDirectSession={session as ChatSessionInfo} {...hostProps} />,
    );

    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 30)); });
    expect(geometry.scrollTop).toBe(120);
  });

  it("yields queued opening frames to the first manual scroll", async () => {
    const queuedFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [oldMessage, latestMessage],
      messagesLoading: false,
    });
    await renderWithAct(
      <ChatView projectId="project" addToast={vi.fn()} initialDirectSession={activeSessionFixture} persistChatPreferences={false} />,
    );
    const transcript = document.querySelector<HTMLElement>(".chat-messages")!;
    const geometry = installTranscriptGeometry(transcript, 1_600);
    geometry.setScrollTop(120);
    act(() => fireEvent.scroll(transcript));

    act(() => {
      for (const callback of queuedFrames.splice(0)) callback(0);
    });

    expect(geometry.scrollTop).toBe(120);
  });

  it("preserves a reader's manual position through later messages and streaming growth", async () => {
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [oldMessage, latestMessage],
      messagesLoading: false,
    });
    const view = await renderWithAct(
      <ChatView projectId="project" addToast={vi.fn()} initialDirectSession={activeSessionFixture} persistChatPreferences={false} />,
    );
    const transcript = document.querySelector<HTMLElement>(".chat-messages")!;
    const geometry = installTranscriptGeometry(transcript, 1_600);
    geometry.setScrollTop(120);
    act(() => fireEvent.scroll(transcript));

    geometry.setScrollHeight(1_900);
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [oldMessage, latestMessage, message("message-new", "Nouveau message sans reprise")],
      messagesLoading: false,
      isStreaming: true,
      streamingText: "Réponse en cours",
    });
    view.rerender(
      <ChatView projectId="project" addToast={vi.fn()} initialDirectSession={activeSessionFixture} persistChatPreferences={false} />,
    );

    expect(await screen.findByText("Réponse en cours")).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 30)); });
    expect(geometry.scrollTop).toBe(120);
  });

  it("keeps an undefined or empty session on the conversation list without a transcript", async () => {
    setupMockChat({ activeSession: null, sessions: [], filteredSessions: [], messages: [] });
    await renderWithAct(<ChatView projectId="project" addToast={vi.fn()} />);
    expect(document.querySelector(".chat-messages")).toBeNull();
    expect(screen.queryByText(latestMessage.content)).not.toBeInTheDocument();
  });
});

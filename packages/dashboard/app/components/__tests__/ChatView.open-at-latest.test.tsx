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

const oldMessage = message("message-old", "Message précédent");
const latestMessage = message("message-latest", "Dernier message restauré");

/*
FNXC:ChatScrollAnchor 2026-09-07-22:17:
FN-313 traite chaque ouverture de fil comme une nouvelle propriété du viewport: après le montage list-first, un changement depuis un fil détaché ou le chargement asynchrone de la transcription, chaque hôte partagé se stabilise sur la hauteur courante. Un défilement manuel ne protège que l’incarnation du fil où il a eu lieu.
*/
const chatHostCases = [
  ["provider desktop", "desktop", activeSessionFixture, {}],
  ["provider mobile", "mobile", activeSessionFixture, {}],
  ["CLI floating", "desktop", { ...activeSessionFixture, cliExecutorAdapterId: "claude" }, { floating: true }],
  ["CLI dock", "desktop", { ...activeSessionFixture, cliExecutorAdapterId: "claude" }, { compactLayout: true }],
] as const;

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

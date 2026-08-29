// @vitest-environment jsdom
import { act, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import * as api from "../../api";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../SessionTerminal", () => ({
  SessionTerminal: () => <div data-testid="session-terminal">terminal</div>,
}));

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
vi.mock("../../hooks/useModelsCache", () => ({
  useModelsCache: () => ({
    models: [{ id: "gpt-4o", provider: "openai", name: "GPT-4o" }],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "openai",
    defaultModelId: "gpt-4o",
    loading: false,
    refresh: vi.fn(async () => undefined),
  }),
}));
vi.mock("../../hooks/useAgentsMapCache", () => ({
  useAgentsMapCache: () => ({
    loading: false,
    agents: [
      { id: "agent-alpha", name: "Alpha", role: "engineer" },
      { id: "agent-beta", name: "Beta", role: "reviewer" },
    ],
    agentsMap: new Map([
      ["agent-alpha", { id: "agent-alpha", name: "Alpha", role: "engineer" }],
      ["agent-beta", { id: "agent-beta", name: "Beta", role: "reviewer" }],
    ]),
    refresh: vi.fn(async () => undefined),
  }),
}));
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value, thinkingLevel, defaultThinkingLevel }: { value?: string; thinkingLevel?: string; defaultThinkingLevel?: string }) => (
    <div
      data-testid="custom-model-dropdown"
      data-value={value ?? ""}
      data-thinking-value={thinkingLevel ?? ""}
      data-default-thinking={defaultThinkingLevel ?? ""}
    />
  ),
}));
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue([]),
    fetchSettings: vi.fn().mockResolvedValue({}),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  };
});

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);
const mockFetchSettings = vi.mocked(api.fetchSettings);

async function renderWithAct(ui: Parameters<typeof rtlRender>[0]) {
  let result: ReturnType<typeof rtlRender> | undefined;
  await act(async () => {
    result = rtlRender(ui);
  });
  return result!;
}

function makeSession(overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo {
  return {
    id: "sess-1",
    agentId: "agent-alpha",
    status: "active",
    title: "Alpha chat",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function chatState(overrides: Partial<UseChatReturn> = {}): UseChatReturn {
  const activeSession = "activeSession" in overrides ? overrides.activeSession ?? null : null;
  const sessions = "sessions" in overrides ? overrides.sessions ?? [] : activeSession ? [activeSession] : [];
  return {
    sessions,
    activeSession,
    sessionsLoading: false,
    messages: [],
    messagesLoading: false,
    isStreaming: false,
    streamingText: "",
    streamingThinking: "",
    streamingToolCalls: [],
    selectSession: vi.fn(),
    createSession: vi.fn(),
    archiveSession: vi.fn(),
    renameSession: vi.fn(),
    setSessionThinkingLevel: vi.fn(),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    editMessageAndResend: vi.fn(),
    stopStreaming: vi.fn(),
    pendingMessages: [],
    clearPendingMessage: vi.fn(),
    loadMoreMessages: vi.fn(),
    hasMoreMessages: false,
    searchQuery: "",
    setSearchQuery: vi.fn(),
    filteredSessions: sessions,
    refreshSessions: vi.fn(),
    agentsMap: new Map(),
    ...overrides,
  };
}

function roomsState(overrides: Partial<UseChatRoomsResult> = {}): UseChatRoomsResult {
  return {
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
    ...overrides,
  };
}

function mockDesktopViewport() {
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function mockMobileViewport() {
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("max-width: 768px") || query.includes("max-height: 480px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

async function waitForSettings() {
  await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());
  await act(async () => undefined);
}

async function selectDirectSession(sessionId = "sess-1") {
  fireEvent.click(screen.getByTestId(`chat-session-${sessionId}`));
  await waitFor(() => expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument());
}

describe("ChatView New Chat project default behavior", () => {
  beforeEach(() => {
    _resetInitialViewportHeight();
    localStorage.clear();
    vi.clearAllMocks();
    mockDesktopViewport();
    mockFetchSettings.mockResolvedValue({ defaultThinkingLevel: "medium" } as Awaited<ReturnType<typeof api.fetchSettings>>);
  });

  it("creates immediately from the configured model default without rendering the removed dialog", async () => {
    const createSession = vi.fn();
    mockFetchSettings.mockResolvedValue({
      chatDefaultKind: "model", chatDefaultModelProvider: "anthropic", chatDefaultModelId: "claude-sonnet-4-5", chatDefaultThinkingLevel: "high",
    } as Awaited<ReturnType<typeof api.fetchSettings>>);
    mockUseChat.mockReturnValue(chatState({ createSession }));
    await renderWithAct(<ChatView projectId="project-a" addToast={vi.fn()} />);
    await waitForSettings();
    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);
    expect(createSession).toHaveBeenCalledWith({ agentId: "__fn_agent__", modelProvider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high" });
    expect(screen.queryByTestId("chat-new-dialog-mode-toggle")).toBeNull();
  });

  it("creates immediately from the configured agent default", async () => {
    const createSession = vi.fn();
    mockFetchSettings.mockResolvedValue({ chatDefaultKind: "agent", chatDefaultAgentId: "agent-beta" } as Awaited<ReturnType<typeof api.fetchSettings>>);
    mockUseChat.mockReturnValue(chatState({ createSession }));
    await renderWithAct(<ChatView projectId="project-a" addToast={vi.fn()} />);
    await waitForSettings();
    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);
    expect(createSession).toHaveBeenCalledWith({ agentId: "agent-beta" });
  });

  it("falls back to the cached model default when Settings has no chat default", async () => {
    const createSession = vi.fn();
    mockUseChat.mockReturnValue(chatState({ createSession }));
    await renderWithAct(<ChatView projectId="project-a" addToast={vi.fn()} />);
    await waitForSettings();
    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);
    expect(createSession).toHaveBeenCalledWith({ agentId: "__fn_agent__", modelProvider: "openai", modelId: "gpt-4o" });
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])("opens Ctrl/Cmd New Chat without changing the origin thread", async (modifier) => {
    const originSession = makeSession({ id: "origin-session" });
    const createdSession = makeSession({ id: "new-window-session" });
    const createSession = vi.fn().mockResolvedValue(createdSession);
    const onOpenSessionInNewWindow = vi.fn();
    const selectSession = vi.fn();
    mockUseChat.mockReturnValue(chatState({
      activeSession: originSession,
      sessions: [originSession],
      createSession,
      selectSession,
    }));
    await renderWithAct(
      <ChatView
        projectId="project-a"
        addToast={vi.fn()}
        floating
        initialDirectSession={originSession}
        initialDirectSessionNonce={1}
        persistChatPreferences={false}
        onOpenSessionInNewWindow={onOpenSessionInNewWindow}
      />,
    );
    await waitForSettings();
    expect(document.querySelector(".chat-view")).toHaveClass("chat-view--detail");
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("chat-new-btn"), modifier);

    await waitFor(() => expect(createSession).toHaveBeenCalledWith(
      { agentId: "__fn_agent__", modelProvider: "openai", modelId: "gpt-4o" },
      { keepActiveSession: true },
    ));
    expect(onOpenSessionInNewWindow).toHaveBeenCalledWith(createdSession);
    expect(selectSession).not.toHaveBeenCalled();
    expect(document.querySelector(".chat-view")).toHaveClass("chat-view--detail");
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();

    /* FNXC:ChatWindows 2026-08-27-09:23: Leaving the thread first makes an unintended setDetailOpen(true) observable without reaching into ChatView's private state. */
    fireEvent.click(screen.getByTestId("chat-back-btn"));
    expect(document.querySelector(".chat-view")).not.toHaveClass("chat-view--detail");
    fireEvent.click(screen.getByTestId("chat-new-btn"), modifier);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    expect(document.querySelector(".chat-view")).not.toHaveClass("chat-view--detail");
  });

  it("uses the same immediate creation path from the mobile host", async () => {
    mockMobileViewport();
    const createSession = vi.fn();
    mockFetchSettings.mockResolvedValue({ chatDefaultKind: "agent", chatDefaultAgentId: "agent-alpha" } as Awaited<ReturnType<typeof api.fetchSettings>>);
    mockUseChat.mockReturnValue(chatState({ createSession }));
    await renderWithAct(<ChatView projectId="project-a" addToast={vi.fn()} />);
    await waitForSettings();
    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);
    expect(createSession).toHaveBeenCalledWith({ agentId: "agent-alpha" });
    expect(screen.queryByTestId("chat-new-dialog-mode-agent")).toBeNull();
  });
});

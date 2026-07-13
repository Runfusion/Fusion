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

describe("ChatView New Chat project default behavior", () => {
  beforeEach(() => {
    _resetInitialViewportHeight();
    localStorage.clear();
    vi.clearAllMocks();
    mockDesktopViewport();
    mockUseChatRooms.mockReturnValue(roomsState());
    mockFetchSettings.mockResolvedValue({ defaultThinkingLevel: "medium" } as Awaited<ReturnType<typeof api.fetchSettings>>);
  });

  it("always-default model creates directly from the desktop New Chat entry without opening the dialog", async () => {
    const createSession = vi.fn();
    mockFetchSettings.mockResolvedValue({
      chatNewSessionMode: "always-default",
      chatDefaultKind: "model",
      chatDefaultModelProvider: "anthropic",
      chatDefaultModelId: "claude-sonnet-4-5",
      chatDefaultThinkingLevel: "high",
      defaultThinkingLevel: "medium",
    } as Awaited<ReturnType<typeof api.fetchSettings>>);
    mockUseChat.mockReturnValue(chatState({ createSession }));

    await renderWithAct(<ChatView projectId="project-a" addToast={vi.fn()} />);
    await waitForSettings();

    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);

    expect(createSession).toHaveBeenCalledWith({
      agentId: "__fn_agent__",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      thinkingLevel: "high",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("always-default agent creates directly without opening the dialog", async () => {
    const createSession = vi.fn();
    mockFetchSettings.mockResolvedValue({
      chatNewSessionMode: "always-default",
      chatDefaultKind: "agent",
      chatDefaultAgentId: "agent-beta",
    } as Awaited<ReturnType<typeof api.fetchSettings>>);
    mockUseChat.mockReturnValue(chatState({ createSession }));

    await renderWithAct(<ChatView projectId="project-a" addToast={vi.fn()} />);
    await waitForSettings();

    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);

    expect(createSession).toHaveBeenCalledWith({ agentId: "agent-beta" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("prompt mode opens the dialog prefilled with the configured model default", async () => {
    const createSession = vi.fn();
    mockFetchSettings.mockResolvedValue({
      chatNewSessionMode: "prompt",
      chatDefaultKind: "model",
      chatDefaultModelProvider: "anthropic",
      chatDefaultModelId: "claude-sonnet-4-5",
      chatDefaultThinkingLevel: "low",
      defaultThinkingLevel: "medium",
    } as Awaited<ReturnType<typeof api.fetchSettings>>);
    mockUseChat.mockReturnValue(chatState({ createSession }));

    await renderWithAct(<ChatView projectId="project-a" addToast={vi.fn()} />);
    await waitForSettings();

    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);

    expect(createSession).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("chat-new-dialog-mode-model")).toHaveClass("chat-new-dialog-mode-btn--active");
    expect(screen.getByTestId("custom-model-dropdown")).toHaveAttribute("data-value", "anthropic/claude-sonnet-4-5");
    expect(screen.getByTestId("custom-model-dropdown")).toHaveAttribute("data-thinking-value", "low");
  });

  it("unset mode opens the dialog prefilled with the configured agent default", async () => {
    const createSession = vi.fn();
    mockFetchSettings.mockResolvedValue({
      chatDefaultKind: "agent",
      chatDefaultAgentId: "agent-alpha",
    } as Awaited<ReturnType<typeof api.fetchSettings>>);
    mockUseChat.mockReturnValue(chatState({ createSession }));

    await renderWithAct(<ChatView projectId="project-a" addToast={vi.fn()} />);
    await waitForSettings();

    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);

    expect(createSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-new-dialog-mode-agent")).toHaveClass("chat-new-dialog-mode-btn--active");
    expect(screen.getByTestId("agent-option-agent-alpha")).toHaveClass("chat-new-dialog-agent-item--selected");
  });

  it("always-default without a resolvable default falls back to the dialog", async () => {
    const createSession = vi.fn();
    mockFetchSettings.mockResolvedValue({
      chatNewSessionMode: "always-default",
      chatDefaultKind: "model",
      chatDefaultModelProvider: "anthropic",
    } as Awaited<ReturnType<typeof api.fetchSettings>>);
    mockUseChat.mockReturnValue(chatState({ createSession }));

    await renderWithAct(<ChatView projectId="project-a" addToast={vi.fn()} />);
    await waitForSettings();

    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);

    expect(createSession).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("mobile session switcher New Chat shares the always-default model path", async () => {
    mockMobileViewport();
    const createSession = vi.fn();
    const session = makeSession();
    mockFetchSettings.mockResolvedValue({
      chatNewSessionMode: "always-default",
      chatDefaultKind: "model",
      chatDefaultModelProvider: "anthropic",
      chatDefaultModelId: "claude-sonnet-4-5",
    } as Awaited<ReturnType<typeof api.fetchSettings>>);
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session], filteredSessions: [session], createSession }));

    await renderWithAct(<ChatView projectId="project-a" addToast={vi.fn()} />);
    await waitForSettings();

    fireEvent.click(screen.getByTestId(`chat-session-${session.id}`));
    fireEvent.click(await screen.findByTestId("chat-mobile-session-trigger"));
    fireEvent.click(screen.getByTestId("chat-mobile-session-new"));

    expect(createSession).toHaveBeenCalledWith({
      agentId: "__fn_agent__",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      thinkingLevel: undefined,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("switching projects clears the previous default while the new project settings load", async () => {
    const createSession = vi.fn();
    mockFetchSettings.mockImplementation(async (projectId?: string) => {
      if (projectId === "project-a") {
        return {
          chatNewSessionMode: "always-default",
          chatDefaultKind: "agent",
          chatDefaultAgentId: "agent-beta",
        } as Awaited<ReturnType<typeof api.fetchSettings>>;
      }
      return {} as Awaited<ReturnType<typeof api.fetchSettings>>;
    });
    mockUseChat.mockReturnValue(chatState({ createSession }));

    const { rerender } = await renderWithAct(<ChatView projectId="project-a" addToast={vi.fn()} />);
    await waitFor(() => expect(mockFetchSettings).toHaveBeenCalledWith("project-a"));
    await act(async () => undefined);

    rerender(<ChatView projectId="project-b" addToast={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);

    expect(createSession).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

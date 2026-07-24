// ChatView thinking-level control mount test (FN-7898).
//
// Asserts the Brain-icon ChatThinkingLevelControl renders in the direct-session
// (non-CLI) composer and the active room composer next to attach. Direct chat retains its
// Model / Agent target section; rooms are level-only. It never renders for CLI-backed
// sessions or direct chat with no active session. Also verifies
// the control's displayed state tracks the active session across a session switch, and
// that it renders without layout regression at a mobile viewport.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import * as api from "../../api";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../SessionTerminal", () => ({
  SessionTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-terminal" data-session-id={sessionId}>
      terminal
    </div>
  ),
}));

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    value,
    onChange,
    defaultThinkingLevel,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    defaultThinkingLevel?: string;
  }) => (
    <button
      type="button"
      data-testid="custom-model-dropdown"
      data-value={value ?? ""}
      data-default-thinking={defaultThinkingLevel ?? ""}
      onClick={() => onChange?.("openai/gpt-4o")}
    >
      model dropdown
    </button>
  ),
}));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue([]),
    fetchSettings: vi.fn().mockResolvedValue({}),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  };
});

async function renderWithAct(ui: Parameters<typeof rtlRender>[0]) {
  let result: ReturnType<typeof rtlRender> | undefined;
  await act(async () => {
    result = rtlRender(ui);
  });
  return result!;
}

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);
const mockFetchSettings = vi.mocked(api.fetchSettings);

function makeSession(overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo {
  return {
    id: "sess-1",
    agentId: "agent-1",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function chatState(overrides: Partial<UseChatReturn> = {}): UseChatReturn {
  const session = "activeSession" in overrides ? overrides.activeSession ?? null : makeSession();
  return {
    sessions: session ? [session] : [],
    activeSession: session,
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
    setSessionModel: vi.fn(),
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
    filteredSessions: session ? [session] : [],
    refreshSessions: vi.fn(),
    agentsMap: new Map(),
    ...overrides,
  };
}

const roomA = {
  id: "room-a",
  name: "Room A",
  slug: "room-a",
  description: null,
  projectId: "proj-123",
  createdBy: "agent-1",
  status: "active" as const,
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

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
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

function mockMobileViewport() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

describe("ChatView thinking-level control (FN-7898)", () => {
  beforeEach(() => {
    _resetInitialViewportHeight();
    vi.clearAllMocks();
    mockFetchSettings.mockResolvedValue({} as Awaited<ReturnType<typeof api.fetchSettings>>);
    localStorage.setItem("fusion:chat-scope", "direct");
    mockDesktopViewport();
    mockUseChatRooms.mockReturnValue(roomsState());
  });

  it("(a) renders in the direct-session composer for a non-CLI active session and selecting a level calls setSessionThinkingLevel(session.id, level)", async () => {
    const setSessionThinkingLevel = vi.fn();
    const session = makeSession({ id: "sess-a", cliExecutorAdapterId: null, thinkingLevel: null });
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session], setSessionThinkingLevel }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const trigger = screen.getByTestId("chat-thinking-btn");
    expect(trigger).toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("chat-thinking-option-high"));

    expect(setSessionThinkingLevel).toHaveBeenCalledWith("sess-a", "high");
  });

  it("selecting a model in the popup calls setSessionModel(session.id, provider/model)", async () => {
    const setSessionModel = vi.fn();
    const session = makeSession({ id: "sess-model", cliExecutorAdapterId: null, agentId: useChatModule.FN_AGENT_ID, modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session], setSessionModel }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("custom-model-dropdown"));

    expect(setSessionModel).toHaveBeenCalledWith("sess-model", { modelProvider: "openai", modelId: "gpt-4o" });
  });

  it("selecting an agent in the popup calls setSessionModel(session.id, agentId)", async () => {
    const setSessionModel = vi.fn();
    const session = makeSession({ id: "sess-agent", cliExecutorAdapterId: null, agentId: useChatModule.FN_AGENT_ID, modelProvider: "openai", modelId: "gpt-4o" });
    const agentsMap = new Map([
      ["agent-001", { id: "agent-001", name: "Alpha", role: "executor" }],
      ["agent-002", { id: "agent-002", name: "Beta", role: "reviewer" }],
    ] as const);
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session], setSessionModel, agentsMap }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    const agentMode = screen.getByTestId("chat-thinking-mode-agent");
    fireEvent.pointerDown(agentMode, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(agentMode, { button: 0, pointerType: "mouse" });
    fireEvent.click(agentMode, { detail: 1 });
    expect(agentMode).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("chat-thinking-model-picker")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-thinking-agent-agent-002"));

    expect(setSessionModel).toHaveBeenCalledWith("sess-agent", { agentId: "agent-002" });
  });

  it("(b) does NOT render when the active session is CLI-backed", async () => {
    const session = makeSession({ id: "sess-cli", cliExecutorAdapterId: "claude-code", cliSessionFile: "cli-native-1" });
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session] }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-thinking-btn")).toBeNull();
  });

  it("(c) renders a level-only control beside attach in the rooms composer", async () => {
    const session = makeSession({ id: "sess-a", cliExecutorAdapterId: null });
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session] }));
    mockUseChatRooms.mockReturnValue(roomsState({ rooms: [roomA], activeRoom: roomA }));
    localStorage.setItem("fusion:chat-scope", "rooms");

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const attachButton = screen.getByTestId("chat-attach-btn");
    const thinkingButton = screen.getByTestId("chat-thinking-btn");
    expect(attachButton.nextElementSibling).toContainElement(thinkingButton);
    fireEvent.click(thinkingButton);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-thinking-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("chat-thinking-model-picker")).toBeNull();

    localStorage.setItem("fusion:chat-scope", "direct");
  });

  it("(d) does NOT render when there is no active session", async () => {
    mockUseChat.mockReturnValue(chatState({ activeSession: null, sessions: [] }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-thinking-btn")).toBeNull();
  });

  it("(e) updates the control selection and closes the popup when switching active sessions", async () => {
    const sessionWithLevel = makeSession({ id: "sess-with-level", cliExecutorAdapterId: null, agentId: useChatModule.FN_AGENT_ID, modelProvider: "openai", modelId: "gpt-4o", thinkingLevel: "high" });
    mockUseChat.mockReturnValue(chatState({ activeSession: sessionWithLevel, sessions: [sessionWithLevel] }));

    const { rerender } = await (async () => {
      let result: ReturnType<typeof rtlRender> | undefined;
      await act(async () => {
        result = rtlRender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      });
      return result!;
    })();

    expect(screen.getByTestId("chat-thinking-btn").className).toContain("chat-thinking-btn--active");
    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByTestId("custom-model-dropdown")).toHaveAttribute("data-value", "openai/gpt-4o");

    const sessionWithoutLevel = makeSession({ id: "sess-without-level", cliExecutorAdapterId: null, agentId: "agent-001", thinkingLevel: null });
    const agentsMap = new Map([["agent-001", { id: "agent-001", name: "Alpha", role: "executor" }]] as const);
    mockUseChat.mockReturnValue(chatState({ activeSession: sessionWithoutLevel, sessions: [sessionWithoutLevel], agentsMap }));

    await act(async () => {
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    });

    expect(screen.queryByTestId("chat-thinking-popover")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByTestId("chat-thinking-agent-agent-001").className).toContain("chat-thinking-agent-item--selected");
  });

  it.each([
    { name: "mobile", configure: mockMobileViewport, props: {} },
    { name: "narrow floating", configure: mockDesktopViewport, props: { floating: true, compactLayout: true } },
  ])("(f) switches to and persists an Agent target from the $name direct-chat host", async ({ name, configure, props }) => {
    configure();
    const setSessionModel = vi.fn();
    const session = makeSession({ id: `sess-${name.replaceAll(" ", "-")}`, cliExecutorAdapterId: null, agentId: useChatModule.FN_AGENT_ID });
    const agentsMap = new Map([
      ["agent-001", { id: "agent-001", name: "Alpha", role: "executor" }],
      ["agent-002", { id: "agent-002", name: "Beta", role: "reviewer" }],
    ] as const);
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session], agentsMap, setSessionModel }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} {...props} />);

    expect(document.querySelector(".chat-view--narrow")).toBeTruthy();
    if (props.floating) expect(document.querySelector(".chat-view--floating")).toBeTruthy();

    const trigger = screen.getByTestId("chat-thinking-btn");
    expect(trigger.closest(".chat-input-row")).not.toBeNull();
    fireEvent.click(trigger);

    // Match the Windows Electron pointer activation whose click can be consumed by a host.
    const agentMode = screen.getByTestId("chat-thinking-mode-agent");
    fireEvent.pointerDown(agentMode, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(agentMode, { button: 0, pointerType: "mouse" });
    fireEvent.click(agentMode, { detail: 1 });

    expect(agentMode).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("chat-thinking-model-picker")).toBeNull();
    expect(screen.getByTestId("chat-thinking-agent-list")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chat-thinking-agent-agent-002"));

    expect(setSessionModel).toHaveBeenCalledWith(session.id, { agentId: "agent-002" });
  });

  it("(g) uses the resolved Settings default for both the in-chat and New Chat thinking-level labels", async () => {
    mockFetchSettings.mockResolvedValue({ defaultThinkingLevel: "medium" } as Awaited<ReturnType<typeof api.fetchSettings>>);
    const session = makeSession({ id: "sess-default-medium", cliExecutorAdapterId: null, thinkingLevel: null });
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session] }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(await screen.findByText("Default (medium)")).toBeInTheDocument();

    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);
    fireEvent.click(screen.getByTestId("chat-new-dialog-mode-model"));

    expect(await screen.findByTestId("custom-model-dropdown")).toHaveAttribute("data-default-thinking", "medium");
  });

  it("(h) falls back to off for both chat thinking-level surfaces when Settings has no default", async () => {
    mockFetchSettings.mockResolvedValue({} as Awaited<ReturnType<typeof api.fetchSettings>>);
    const session = makeSession({ id: "sess-default-off", cliExecutorAdapterId: null, thinkingLevel: null });
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session] }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByText("Default (off)")).toBeInTheDocument();

    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);
    fireEvent.click(screen.getByTestId("chat-new-dialog-mode-model"));

    expect(await screen.findByTestId("custom-model-dropdown")).toHaveAttribute("data-default-thinking", "off");
  });
});

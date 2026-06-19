/**
 * Tests for ChatView component: sidebar, session list, message thread,
 * new chat dialog, and input handling.
 */

import { act, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import type { DiscoveredSkill } from "@fusion/dashboard";
import { loadAllAppCss } from "../../test/cssFixture";
import { FileBrowserProvider } from "../../context/FileBrowserContext";

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();
import * as useChatModule from "../../hooks/useChat";
import type { UseChatReturn, ChatSessionInfo, ChatMessageInfo, ToolCallInfo } from "../../hooks/useChat";
import * as apiModule from "../../api";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";
import { SWR_CACHE_KEYS, writeCache } from "../../utils/swrCache";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";
import * as mobileScrollLock from "../../hooks/useMobileScrollLock";

// Mock the hooks
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);
const mockFetchModels = vi.mocked(apiModule.fetchModels);
const mockFetchDiscoveredSkills = vi.mocked(apiModule.fetchDiscoveredSkills);
const mockCreateObjectURL = vi.fn();
const mockRevokeObjectURL = vi.fn();
const mockClipboardWriteText = vi.fn();

// Mock lucide-react icons - spread actual module and override specific icons
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    MessageSquare: ({ "data-testid": testId, ...props }: any) => (
      <svg data-testid={testId || "icon-message-square"} {...props} />
    ),
    Send: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-send"} {...props} />,
    Plus: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-plus"} {...props} />,
    Search: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-search"} {...props} />,
    Trash2: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-trash"} {...props} />,
    Archive: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-archive"} {...props} />,
    Pencil: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-pencil"} {...props} />,
    ChevronLeft: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-chevron-left"} {...props} />,
    Bot: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-bot"} {...props} />,
    Square: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-square"} {...props} />,
    Eye: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-eye"} {...props} />,
    EyeOff: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-eye-off"} {...props} />,
    Paperclip: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-paperclip"} {...props} />,
    File: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-file"} {...props} />,
    Copy: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-copy"} {...props} />,
    Check: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-check"} {...props} />,
  };
});

// Mock CustomModelDropdown - no longer used but kept for other tests
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => (
    <select
      data-testid="mock-model-dropdown"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Use default</option>
      <option value="anthropic/claude-sonnet-4-5">Claude Sonnet 4.5</option>
      <option value="openai/gpt-4o">GPT-4o</option>
    </select>
  ),
}));

const defaultModelsResponse = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ],
  favoriteProviders: [],
  favoriteModels: [],
  defaultProvider: "anthropic",
  defaultModelId: "claude-sonnet-4-5",
};

// Mock fetchAgents for new chat dialog
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4-5",
  }),
  fetchAgents: vi.fn().mockResolvedValue([
    { id: "agent-001", name: "Alpha", role: "executor", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
    { id: "agent-002", name: "Beta", role: "reviewer", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
  ]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

const defaultChatState: UseChatReturn = {
  sessions: [],
  activeSession: null,
  sessionsLoading: false,
  messages: [],
  messagesLoading: false,
  isStreaming: false,
  streamingText: "",
  streamingThinking: "",
  streamingToolCalls: [],
  selectSession: vi.fn(),
  createSession: vi.fn().mockResolvedValue({ id: "session-new", agentId: "__fn_agent__", status: "active", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" } satisfies ChatSessionInfo),
  archiveSession: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  sendMessage: vi.fn(),
  stopStreaming: vi.fn(),
  pendingMessage: "",
  clearPendingMessage: vi.fn(),
  loadMoreMessages: vi.fn(),
  hasMoreMessages: false,
  searchQuery: "",
  setSearchQuery: vi.fn(),
  filteredSessions: [],
  refreshSessions: vi.fn(),
  agentsMap: new Map(),
};

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

async function renderWithAct(ui: Parameters<typeof rtlRender>[0]) {
  let result: ReturnType<typeof rtlRender> | undefined;
  await act(async () => {
    result = rtlRender(ui);
  });
  return result!;
}

const activeSessionFixture: ChatSessionInfo = {
  id: "session-001",
  agentId: "agent-001",
  status: "active",
  title: "Test Chat",
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

function createMockSkill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: "skill-id",
    name: "skill/name",
    path: "/tmp/skills/skill.md",
    relativePath: "skills/skill.md",
    enabled: true,
    metadata: {
      source: "*",
      scope: "project",
      origin: "top-level",
    },
    ...overrides,
  };
}

function setupMockChat(overrides: Partial<UseChatReturn> = {}) {
  const state: UseChatReturn = { ...defaultChatState, ...overrides };
  mockUseChat.mockReturnValue(state);
}

function setupMockRooms(overrides: Partial<UseChatRoomsResult> = {}) {
  const state: UseChatRoomsResult = { ...defaultRoomsState, ...overrides };
  mockUseChatRooms.mockReturnValue(state);
}

function createRoomFixture(name: string) {
  return {
    id: `room-${name}`,
    projectId: "proj-123",
    slug: name,
    name,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
}

function setupStatefulCreateRoomMock(options?: { createRejects?: boolean }) {
  const createRoom = vi.fn();

  mockUseChatRooms.mockImplementation(() => {
    const [roomsState, setRoomsState] = useState<UseChatRoomsResult["rooms"]>([]);
    const [activeRoom, setActiveRoom] = useState<UseChatRoomsResult["activeRoom"]>(null);

    return {
      ...defaultRoomsState,
      rooms: roomsState,
      activeRoom,
      activeRoomMembers: activeRoom
        ? [{ roomId: activeRoom.id, agentId: "agent-001", role: "member", addedAt: "2026-05-12T00:00:00.000Z" }]
        : [],
      createRoom: async ({ name, memberAgentIds }) => {
        createRoom({ name, memberAgentIds });
        if (options?.createRejects) {
          throw new Error("Failed to create room.");
        }
        const nextRoom = createRoomFixture(name);
        setRoomsState((previous) => [...previous, nextRoom]);
        setActiveRoom(nextRoom);
        return nextRoom;
      },
      selectRoom: (roomId) => {
        setActiveRoom(roomsState.find((room) => room.id === roomId) ?? null);
      },
    } satisfies UseChatRoomsResult;
  });

  return { createRoom };
}

async function renderRoomCreation(options?: { viewport?: "mobile" | "desktop"; createRejects?: boolean }) {
  const viewportSpy = mockViewportMode(options?.viewport ?? "mobile");
  const { createRoom } = setupStatefulCreateRoomMock({ createRejects: options?.createRejects });
  setupMockChat({ sessions: [], filteredSessions: [] });
  localStorage.setItem("fusion:chat-scope", "rooms");

  const user = userEvent.setup({ delay: null });
  await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

  await user.click(screen.getByTestId("chat-create-room-btn"));
  const dialog = await screen.findByRole("dialog", { name: "Create room" });
  fireEvent.change(within(dialog).getByLabelText("Room name"), { target: { value: "newroom" } });
  await user.click(within(screen.getByTestId("create-room-member-list")).getByText("Alpha"));
  await user.click(within(dialog).getByRole("button", { name: "Create room" }));

  return { createRoom, viewportSpy };
}

function ensureMatchMedia() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(),
    });
  }
}

function mockViewportMode(mode: "mobile" | "desktop") {
  ensureMatchMedia();
  const isMobile = mode === "mobile";
  Object.defineProperty(window, "innerWidth", { value: isMobile ? 375 : 1280, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches:
      isMobile &&
      (query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  _resetInitialViewportHeight();
  setupMockRooms();
  mockViewportMode("desktop");
  mockFetchModels.mockResolvedValue({ ...defaultModelsResponse });
  mockFetchDiscoveredSkills.mockResolvedValue([]);
  mockCreateObjectURL.mockImplementation((file: File) => `blob:${file.name}`);
  Object.defineProperty(URL, "createObjectURL", { value: mockCreateObjectURL, writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: mockRevokeObjectURL, writable: true });
  mockClipboardWriteText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mockClipboardWriteText },
    configurable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  _resetInitialViewportHeight();
});

describe("ChatView", () => {

  it("renders empty state when no session is selected", async () => {
    setupMockChat({ sessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    expect(screen.getByTestId("chat-new-btn")).toBeInTheDocument();
  });

  it("renders session list in sidebar", async () => {
    setupMockChat({
      sessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "session-002", agentId: "agent-002", status: "active", title: "Another Chat", createdAt: "2026-04-07T00:00:00.000Z", updatedAt: "2026-04-07T00:00:00.000Z" },
      ],
      filteredSessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "session-002", agentId: "agent-002", status: "active", title: "Another Chat", createdAt: "2026-04-07T00:00:00.000Z", updatedAt: "2026-04-07T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Test Chat")).toBeInTheDocument();
    expect(screen.getByText("Another Chat")).toBeInTheDocument();
  });

  it("calls selectSession when clicking a session", async () => {
    const selectSession = vi.fn();
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      selectSession,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByText("Test Chat"));

    expect(selectSession).toHaveBeenCalledWith("session-001");
  });

  it("highlights active session", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    expect(sessionItem).toHaveClass("chat-session-item--active");
  });

  it("opens new chat dialog when clicking New Chat button", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    // Click the sidebar New Chat button
    await userEvent.click(screen.getByTestId("chat-new-btn"));

    // Dialog should be open - check for dialog content
    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    expect(dialog).toBeInTheDocument();
    // Should show mode toggle with Agent and Model buttons
    expect(within(dialog!).getByTestId("chat-new-dialog-mode-toggle")).toBeInTheDocument();
    expect(within(dialog!).getByTestId("chat-new-dialog-mode-agent")).toBeInTheDocument();
    expect(within(dialog!).getByTestId("chat-new-dialog-mode-model")).toBeInTheDocument();
  });

  it("creates session without model selection (uses default)", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "agent-001" });
    setupMockChat({ sessions: [], filteredSessions: [], createSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;

    // Create button should be disabled initially (no agent selected)
    const createBtn = within(dialog!).getByText("Create") as HTMLButtonElement;
    expect(createBtn).toBeDisabled();

    // Click on an agent to select it
    await userEvent.click(within(dialog!).getByTestId("agent-option-agent-001"));

    // Create button should now be enabled
    expect(createBtn).not.toBeDisabled();

    await userEvent.click(within(dialog!).getByText("Create"));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        agentId: "agent-001",
      });
    });
  });

  it("creates session with agent selection", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "agent-002" });
    setupMockChat({ sessions: [], filteredSessions: [], createSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;

    // Click on a different agent
    await userEvent.click(within(dialog!).getByTestId("agent-option-agent-002"));

    await userEvent.click(within(dialog!).getByText("Create"));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        agentId: "agent-002",
      });
    });
  });

  it("preselects the default model and enables Create in model mode", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    const createBtn = within(dialog!).getByText("Create") as HTMLButtonElement;

    await userEvent.click(within(dialog!).getByTestId("chat-new-dialog-mode-model"));

    await waitFor(() => {
      expect(within(dialog!).getByTestId("mock-model-dropdown")).toHaveValue("anthropic/claude-sonnet-4-5");
    });
    expect(createBtn).toBeEnabled();
  });

  it("creates session with the preselected default model in model mode", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "__fn_agent__" });
    setupMockChat({ sessions: [], filteredSessions: [], createSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    const createBtn = within(dialog!).getByText("Create") as HTMLButtonElement;

    await userEvent.click(within(dialog!).getByTestId("chat-new-dialog-mode-model"));

    await waitFor(() => {
      expect(within(dialog!).getByTestId("mock-model-dropdown")).toHaveValue("anthropic/claude-sonnet-4-5");
    });
    expect(createBtn).toBeEnabled();

    await userEvent.click(createBtn);

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        agentId: "__fn_agent__",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
    });
  });

  it("creates session with the default model when Use default is selected in model mode", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "__fn_agent__" });
    setupMockChat({ sessions: [], filteredSessions: [], createSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    const createBtn = within(dialog!).getByText("Create") as HTMLButtonElement;

    await userEvent.click(within(dialog!).getByTestId("chat-new-dialog-mode-model"));

    const modelDropdown = await within(dialog!).findByTestId("mock-model-dropdown");
    await userEvent.selectOptions(modelDropdown, "");

    expect(modelDropdown).toHaveValue("");
    expect(createBtn).toBeEnabled();

    await userEvent.click(createBtn);

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        agentId: "__fn_agent__",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
    });
  });

  it("keeps Create disabled in model mode when no default model is resolvable", async () => {
    mockFetchModels.mockResolvedValue({
      ...defaultModelsResponse,
      defaultProvider: null,
      defaultModelId: null,
    });
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "__fn_agent__" });
    setupMockChat({ sessions: [], filteredSessions: [], createSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    const createBtn = within(dialog!).getByText("Create") as HTMLButtonElement;

    await userEvent.click(within(dialog!).getByTestId("chat-new-dialog-mode-model"));

    const modelDropdown = await within(dialog!).findByTestId("mock-model-dropdown");
    await userEvent.selectOptions(modelDropdown, "");

    expect(modelDropdown).toHaveValue("");
    expect(createBtn).toBeDisabled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("creates session with an explicitly selected non-default model in model mode", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "__fn_agent__" });
    setupMockChat({ sessions: [], filteredSessions: [], createSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;

    await userEvent.click(within(dialog!).getByTestId("chat-new-dialog-mode-model"));

    const modelDropdown = await within(dialog!).findByTestId("mock-model-dropdown");
    await userEvent.selectOptions(modelDropdown, "openai/gpt-4o");

    await userEvent.click(within(dialog!).getByText("Create"));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        agentId: "__fn_agent__",
        modelProvider: "openai",
        modelId: "gpt-4o",
      });
    });
  });

  it("creates session without model selection omits model fields (agent mode)", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "agent-001" });
    setupMockChat({ sessions: [], filteredSessions: [], createSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;

    // Agent mode is default — just select an agent and create
    await userEvent.click(within(dialog!).getByTestId("agent-option-agent-001"));

    await userEvent.click(within(dialog!).getByText("Create"));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        agentId: "agent-001",
      });
    });
  });

  it("agent mode shows agent list without model dropdown", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;

    // Agent mode is active by default — agent list visible, model section hidden
    await waitFor(() => {
      expect(within(dialog!).getByTestId("agent-option-agent-001")).toBeInTheDocument();
    });
    expect(within(dialog!).queryByTestId("chat-new-dialog-model-section")).toBeNull();
  });

  it("model mode shows model dropdown without agent list", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;

    // Switch to model mode
    await userEvent.click(within(dialog!).getByTestId("chat-new-dialog-mode-model"));

    // Model section visible, no agent list
    await waitFor(() => {
      expect(within(dialog!).getByTestId("chat-new-dialog-model-section")).toBeInTheDocument();
    });
    expect(within(dialog!).queryByTestId("agent-option-agent-001")).toBeNull();
  });

  it("toggle between modes clears opposite selection", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;

    // Select an agent in agent mode
    await userEvent.click(within(dialog!).getByTestId("agent-option-agent-001"));
    expect(within(dialog!).getByTestId("agent-option-agent-001").classList.contains("chat-new-dialog-agent-item--selected")).toBe(true);

    // Switch to model mode — agent selection should be cleared
    await userEvent.click(within(dialog!).getByTestId("chat-new-dialog-mode-model"));

    // Switch back to agent mode — Create should be disabled (no agent selected)
    await userEvent.click(within(dialog!).getByTestId("chat-new-dialog-mode-agent"));

    await waitFor(() => {
      expect(within(dialog!).getByText("Create")).toBeDisabled();
    });
  });

  it("renders messages for active session", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi there!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
  });

  it("renders file paths in assistant inline code as clickable links while preserving the code wrapper", async () => {
    const openFile = vi.fn();
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "see `packages/foo/bar.ts:42` for details", createdAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(
      <FileBrowserProvider openFile={openFile}>
        <ChatView projectId="proj-123" addToast={vi.fn()} />
      </FileBrowserProvider>,
    );

    const fileLink = screen.getByRole("button", { name: "packages/foo/bar.ts:42" });
    const code = fileLink.closest("code");
    expect(code).toBeTruthy();
    expect(code?.querySelector("button.file-path-link")).toBe(fileLink);

    await userEvent.click(fileLink);
    expect(openFile).toHaveBeenCalledWith("packages/foo/bar.ts", { line: 42, col: undefined });
  });

  it("does not render markdown/plain toggle controls in the thread header", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-render-mode-markdown")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-render-mode-plain")).not.toBeInTheDocument();
  });

  it("thread-header toggle flips every assistant bubble between rendered Markdown and plain text", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "**First** item", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-002", sessionId: "session-001", role: "assistant", content: "**Second** item", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const firstBubble = screen.getByTestId("chat-message-msg-001");
    const secondBubble = screen.getByTestId("chat-message-msg-002");
    const headerToggle = screen.getByTestId("chat-thread-render-toggle");

    // Per-message toggles were intentionally removed; only the single
    // thread-level toggle should exist.
    expect(screen.queryAllByTestId("chat-message-render-toggle")).toHaveLength(0);
    expect(within(firstBubble).getByText("First", { selector: "strong" })).toBeInTheDocument();
    expect(within(secondBubble).getByText("Second", { selector: "strong" })).toBeInTheDocument();

    await userEvent.click(headerToggle);

    expect(within(firstBubble).getByText(/\*\*First\*\* item/)).toBeInTheDocument();
    expect(within(firstBubble).queryByText("First", { selector: "strong" })).toBeNull();
    expect(within(secondBubble).getByText(/\*\*Second\*\* item/)).toBeInTheDocument();
    expect(within(secondBubble).queryByText("Second", { selector: "strong" })).toBeNull();

    await userEvent.click(headerToggle);
    expect(within(firstBubble).getByText("First", { selector: "strong" })).toBeInTheDocument();
    expect(within(secondBubble).getByText("Second", { selector: "strong" })).toBeInTheDocument();
  });

  it("thread-header toggle also drives the streaming bubble", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "**Persisted**", createdAt: "2026-04-08T00:00:00.000Z" }],
      isStreaming: true,
      streamingText: "**Live** stream",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const persistedBubble = screen.getByTestId("chat-message-msg-001");
    const streamingBubble = document.querySelector(".chat-message--streaming") as HTMLElement;
    const headerToggle = screen.getByTestId("chat-thread-render-toggle");

    expect(within(streamingBubble).getByText("Live", { selector: "strong" })).toBeInTheDocument();
    expect(within(persistedBubble).getByText("Persisted", { selector: "strong" })).toBeInTheDocument();

    await userEvent.click(headerToggle);

    expect(within(streamingBubble).getByText(/\*\*Live\*\* stream/)).toBeInTheDocument();
    expect(within(persistedBubble).getByText(/\*\*Persisted\*\*/)).toBeInTheDocument();

    await userEvent.click(headerToggle);
    expect(within(streamingBubble).getByText("Live", { selector: "strong" })).toBeInTheDocument();
    expect(within(persistedBubble).getByText("Persisted", { selector: "strong" })).toBeInTheDocument();
  });

  it("renders tool calls from persisted messages", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "I used a tool",
          toolCalls: [
            {
              toolName: "read",
              args: { path: "foo.ts" },
              isError: false,
              result: "contents",
              status: "completed",
            },
          ],
          createdAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("read")).toBeInTheDocument();
    const preview = document.querySelector(".chat-tool-call-preview") as HTMLElement | null;
    expect(preview).toHaveTextContent("result: contents");
  });

  it("renders streaming tool calls", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [{ id: "msg-001", sessionId: "session-001", role: "user", content: "Use tools", createdAt: "2026-04-08T00:00:00.000Z" }],
      isStreaming: true,
      streamingText: "Working...",
      streamingToolCalls: [
        {
          toolName: "read",
          args: { path: "foo.ts" },
          isError: false,
          status: "running",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const streamingBubble = document.querySelector(".chat-message--streaming") as HTMLElement | null;
    expect(streamingBubble).toBeInTheDocument();
    expect(within(streamingBubble as HTMLElement).getByText("read")).toBeInTheDocument();
    const preview = (streamingBubble as HTMLElement).querySelector(".chat-tool-call-preview");
    expect(preview).toHaveTextContent("path=foo.ts");
  });

  it("collapses multiple tool calls into single summary line", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "Done",
          toolCalls: [
            {
              toolName: "read",
              isError: false,
              result: "contents",
              status: "completed",
            },
            {
              toolName: "grep",
              isError: false,
              result: "matches",
              status: "completed",
            },
          ],
          createdAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const group = screen.getByTestId("chat-tool-calls-group") as HTMLDetailsElement;
    expect(group).toBeInTheDocument();
    expect(group.open).toBe(false);

    const summary = group.querySelector(".chat-tool-calls-group-summary") as HTMLElement;
    expect(summary).toBeInTheDocument();
    expect(summary.querySelector(".chat-tool-calls-count")).toHaveTextContent("2 tool calls");
    expect(summary.querySelector(".chat-tool-calls-names")).toHaveTextContent("read, grep");
  });

  it("auto-opens grouped tool calls when any tool call is running", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "Running",
          toolCalls: [
            {
              toolName: "read",
              isError: false,
              status: "running",
            },
            {
              toolName: "grep",
              isError: false,
              result: "done",
              status: "completed",
            },
          ],
          createdAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const group = screen.getByTestId("chat-tool-calls-group") as HTMLDetailsElement;
    expect(group).toBeInTheDocument();
    expect(group.open).toBe(true);
  });

  it("shows status counts in group summary", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "Mixed",
          toolCalls: [
            {
              toolName: "read",
              isError: false,
              result: "contents",
              status: "completed",
            },
            {
              toolName: "grep",
              isError: false,
              status: "running",
            },
            {
              toolName: "write",
              isError: true,
              result: "failed",
              status: "completed",
            },
          ],
          createdAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("(1 running)")).toBeInTheDocument();
  });

  it("shows error count when there are errors and no running calls", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "Mixed",
          toolCalls: [
            {
              toolName: "read",
              isError: false,
              result: "contents",
              status: "completed",
            },
            {
              toolName: "write",
              isError: true,
              result: "failed",
              status: "completed",
            },
          ],
          createdAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("(1 error)")).toBeInTheDocument();
  });

  it("expands grouped tool calls to reveal individual tool items", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "Done",
          toolCalls: [
            {
              toolName: "read",
              isError: false,
              result: "contents",
              status: "completed",
            },
            {
              toolName: "grep",
              isError: false,
              result: "matches",
              status: "completed",
            },
          ],
          createdAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const group = screen.getByTestId("chat-tool-calls-group") as HTMLDetailsElement;
    expect(group.open).toBe(false);

    const summary = group.querySelector(".chat-tool-calls-group-summary") as HTMLElement;
    await userEvent.click(summary);

    expect(group.open).toBe(true);
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("grep")).toBeInTheDocument();
  });

  it("single tool call renders without group wrapper", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "Done",
          toolCalls: [
            {
              toolName: "read",
              isError: false,
              result: "contents",
              status: "completed",
            },
          ],
          createdAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-tool-calls-group")).not.toBeInTheDocument();
    const details = document.querySelector(".chat-tool-call") as HTMLDetailsElement | null;
    expect(details).toBeInTheDocument();
    expect(details?.open).toBe(false);
    expect(details?.querySelector(".chat-tool-call-name")).toHaveTextContent("read");
    expect(details?.querySelector(".chat-tool-call-status-text")).toHaveTextContent("completed");
  });

  it("renders latest question tool calls as inline response UI and sends answers", async () => {
    const sendMessage = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Question Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      sendMessage,
      messages: [
        {
          id: "msg-001",
          sessionId: "session-001",
          role: "assistant",
          content: "Need input",
          toolCalls: [{ toolName: "ask_user", args: { question: "Pick?", options: ["Alpha", "Beta"] }, isError: false, status: "completed" }],
          createdAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-question-response")).toBeInTheDocument();
    expect(document.querySelector(".chat-tool-call")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("chat-question-response-option-q-0-opt-0"));
    await userEvent.click(screen.getByTestId("chat-question-response-submit"));

    expect(sendMessage).toHaveBeenCalledWith("> Q: Pick?\nAlpha");
  });

  it("renders historical question tool calls read-only with submitted answer", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Question Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        {
          id: "msg-001",
          sessionId: "session-001",
          role: "assistant",
          content: "Need input",
          toolCalls: [{ toolName: "ask_user", args: { question: "Pick?", options: ["Alpha", "Beta"] }, isError: false, status: "completed" }],
          createdAt: "2026-04-08T00:00:00.000Z",
        },
        { id: "msg-002", sessionId: "session-001", role: "user", content: "> Q: Pick?\nBeta", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-question-response")).toHaveTextContent("Answered");
    expect(screen.getByTestId("chat-question-response-submitted-answer")).toHaveTextContent("Beta");
    expect(screen.queryByTestId("chat-question-response-submit")).not.toBeInTheDocument();
  });

  it("truncates tool names when more than 5 unique", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "Done",
          toolCalls: [
            { toolName: "read", isError: false, status: "completed" },
            { toolName: "edit", isError: false, status: "completed" },
            { toolName: "bash", isError: false, status: "completed" },
            { toolName: "grep", isError: false, status: "completed" },
            { toolName: "write", isError: false, status: "completed" },
            { toolName: "list", isError: false, status: "completed" },
          ],
          createdAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("read, edit, bash, grep, write, +1 more")).toBeInTheDocument();
  });

  it("running tool calls show running indicator", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "Running",
          toolCalls: [
            {
              toolName: "read",
              isError: false,
              status: "running",
            },
          ],
          createdAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(document.querySelector(".chat-tool-call--running")).toBeInTheDocument();
  });

  it("error tool calls show error styling", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        {
          id: "msg-002",
          sessionId: "session-001",
          role: "assistant",
          content: "Error",
          toolCalls: [
            {
              toolName: "read",
              isError: true,
              result: "failed",
              status: "completed",
            },
          ],
          createdAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(document.querySelector(".chat-tool-call--error")).toBeInTheDocument();
  });

  it("shows resolved agent name in assistant message avatar", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Agent Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello from Alpha", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const avatar = document.querySelector(".chat-message-avatar") as HTMLElement | null;
    expect(avatar).toBeInTheDocument();

    await waitFor(() => {
      expect(within(avatar!).getByText("Alpha")).toBeInTheDocument();
    });
    expect(within(avatar!).queryByText("Fusion")).not.toBeInTheDocument();
  });

  it("hides per-message assistant identity for fn agent (model-only) sessions", async () => {
    // Model-only chats use the active model as their identity, which is
    // already shown in the thread header. We deliberately suppress the
    // per-message avatar to avoid repeating it on every reply.
    setupMockChat({
      activeSession: { id: "session-001", agentId: "__fn_agent__", status: "active", title: "Fusion Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Built-in assistant response", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-001");
    expect(messageBubble.querySelector(".chat-message-avatar")).toBeNull();
  });

  it("hides per-message assistant identity for fn agent (model-only) sessions even when a model is configured", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Fusion Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Built-in assistant response", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-001");
    expect(messageBubble.querySelector(".chat-message-avatar")).toBeNull();
    // The model name still appears once in the thread header.
    await waitFor(() => {
      expect(screen.getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    });
  });

  it("shows copy actions only for assistant responses in provider/model chats", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Fusion Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-user", sessionId: "session-001", role: "user", content: "Question", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-assistant", sessionId: "session-001", role: "assistant", content: "Answer", createdAt: "2026-04-08T00:00:01.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-copy-response-msg-assistant")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-copy-response-msg-user")).not.toBeInTheDocument();
  });

  it("copies raw provider response content and shows feedback for success/failure", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Fusion Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-assistant", sessionId: "session-001", role: "assistant", content: "**Raw** output", createdAt: "2026-04-08T00:00:01.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const copyButton = screen.getByTestId("chat-copy-response-msg-assistant");
    expect(copyButton).not.toHaveTextContent("Copy");
    await userEvent.click(copyButton);

    expect(mockClipboardWriteText).toHaveBeenCalledWith("**Raw** output");
    expect(screen.getByLabelText("Response copied")).toBeInTheDocument();

    mockClipboardWriteText.mockRejectedValueOnce(new Error("denied"));
    await userEvent.click(screen.getByTestId("chat-copy-response-msg-assistant"));
    expect(screen.getByLabelText("Copy failed")).toBeInTheDocument();
  });

  it("renders assistant failure bubbles inline with detail affordances", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Fusion Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        {
          id: "msg-failure",
          sessionId: "session-001",
          role: "assistant",
          content: "Model request failed",
          failureInfo: {
            summary: "Model request failed",
            errorClass: "ProviderError",
            code: "E_MODEL",
            detail: "ProviderError: Model request failed",
            reference: { kind: "mailbox", id: "msg-42", label: "Mailbox message msg-42" },
          },
          createdAt: "2026-04-08T00:00:01.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-failure");
    expect(messageBubble).toHaveClass("chat-message--failure");
    expect(within(messageBubble).getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    expect(within(messageBubble).getByText("Response failed")).toBeInTheDocument();
    expect(within(messageBubble).getByText("ProviderError")).toBeInTheDocument();
    expect(within(messageBubble).getByText("E_MODEL")).toBeInTheDocument();
    expect(within(messageBubble).queryByTestId("chat-copy-response-msg-failure")).not.toBeInTheDocument();

    await userEvent.click(within(messageBubble).getByText("Failure details"));

    expect(within(messageBubble).getByText("ProviderError: Model request failed")).toBeInTheDocument();
    expect(within(messageBubble).getByText("Mailbox message msg-42")).toBeInTheDocument();
    expect(within(messageBubble).getByRole("link", { name: "Open mailbox message" })).toHaveAttribute(
      "href",
      "/?view=mailbox&mailbox-message=msg-42#message-msg-42",
    );
    expect(messageBubble.querySelector(".status-dot.status-dot--error")).toBeInTheDocument();
  });

  it("renders a generic failure reference details affordance for non-mailbox references", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "agent-001",
        status: "active",
        title: "Agent Chat",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        {
          id: "msg-run-failure",
          sessionId: "session-001",
          role: "assistant",
          content: "Run failed",
          failureInfo: {
            summary: "Run failed",
            reference: { kind: "agent-run", id: "run-42", label: "Agent run 42" },
          },
          createdAt: "2026-04-08T00:00:02.000Z",
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-run-failure");
    await userEvent.click(within(messageBubble).getByText("Failure details"));
    await userEvent.click(within(messageBubble).getByText("View failure details"));

    expect(within(messageBubble).getAllByText("Agent run 42")).toHaveLength(2);
    expect(within(messageBubble).getByText("Kind")).toBeInTheDocument();
    expect(within(messageBubble).getByText("agent-run")).toBeInTheDocument();
    expect(within(messageBubble).getByText("ID")).toBeInTheDocument();
    expect(within(messageBubble).getByText("run-42")).toBeInTheDocument();
  });

  it("shows streaming copy action for provider chats", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Fusion Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [],
      isStreaming: true,
      streamingText: "Live answer",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-copy-response-streaming")).toBeInTheDocument();
  });

  it("does not show copy actions for non-provider sessions", async () => {
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [
        { id: "msg-assistant", sessionId: "session-001", role: "assistant", content: "Answer", createdAt: "2026-04-08T00:00:01.000Z" },
      ],
      isStreaming: true,
      streamingText: "Live answer",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-copy-response-msg-assistant")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-copy-response-streaming")).not.toBeInTheDocument();
  });

  it("shows resolved agent name in streaming assistant avatar", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Agent Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Think", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
      isStreaming: true,
      streamingText: "Thinking...",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const avatar = document.querySelector(".chat-message--streaming .chat-message-avatar") as HTMLElement | null;
    expect(avatar).toBeInTheDocument();

    await waitFor(() => {
      expect(within(avatar!).getByText("Alpha")).toBeInTheDocument();
    });
  });

  it("intercepts exact /clear and starts a fresh session instead of sending message", async () => {
    const sendMessage = vi.fn();
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "agent-001" });
    const stopStreaming = vi.fn();
    const clearPendingMessage = vi.fn();

    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [],
      sendMessage,
      createSession,
      stopStreaming,
      clearPendingMessage,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "  /clear  {enter}");

    expect(sendMessage).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith({ agentId: "agent-001" });
    expect(stopStreaming).toHaveBeenCalledTimes(1);
    expect(clearPendingMessage).toHaveBeenCalledTimes(1);
  });

  it("intercepts exact /new and starts a fresh session instead of sending message", async () => {
    const sendMessage = vi.fn();
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "agent-001" });
    const stopStreaming = vi.fn();
    const clearPendingMessage = vi.fn();

    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [],
      sendMessage,
      createSession,
      stopStreaming,
      clearPendingMessage,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "  /new  {enter}");

    expect(sendMessage).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith({ agentId: "agent-001" });
    expect(stopStreaming).toHaveBeenCalledTimes(1);
    expect(clearPendingMessage).toHaveBeenCalledTimes(1);
  });

  it("does not intercept non-exact /new text", async () => {
    const sendMessage = vi.fn();
    const createSession = vi.fn();
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [],
      sendMessage,
      createSession,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "/new now{enter}");

    expect(sendMessage).toHaveBeenCalledWith("/new now", []);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("does not intercept non-exact /clear text", async () => {
    const sendMessage = vi.fn();
    const createSession = vi.fn();
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [],
      sendMessage,
      createSession,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "/clear now{enter}");

    expect(sendMessage).toHaveBeenCalledWith("/clear now", []);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("sends message on Enter key", async () => {
    const sendMessage = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      sendMessage,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "Hello world{enter}");

    expect(sendMessage).toHaveBeenCalledWith("Hello world", []);
  });

  it("sends message on touch tap when the synthetic click is suppressed (mobile)", async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
    try {
      const sendMessage = vi.fn();
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [],
        sendMessage,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "Touch hello");

      const sendButton = screen.getByTestId("chat-send-btn");
      // iOS suppresses the trailing synthetic click after preventDefault() in the
      // touch sequence, so the send must fire from the touch handlers. Both
      // pointerdown (touch) and touchstart fire for one tap; the result must be a
      // single send, not zero (bug) and not two (double-fire).
      await act(async () => {
        fireEvent.pointerDown(sendButton, { pointerType: "touch" });
        fireEvent.touchStart(sendButton);
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith("Touch hello", []);
    } finally {
      Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
    }
  });

  it("FN-6576 sends each of two consecutive direct iOS taps within the click-latch window", async () => {
    const viewportSpy = mockViewportMode("mobile");
    const sendMessage = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      sendMessage,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Direct first" } });
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("chat-send-btn"), { pointerType: "touch" });
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith("Direct first", []);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "Direct second" } });
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("chat-send-btn"), { pointerType: "touch" });
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith("Direct second", []);
    viewportSpy.mockRestore();
  });

  it("clears room composer on Enter after successful room send", async () => {
    localStorage.setItem("fusion:chat-scope", "rooms");
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });
    setupMockRooms({
      activeRoom: {
        id: "room-001",
        projectId: "proj-123",
        name: "backend",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      sendRoomMessage,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "Room hello{enter}");

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("Room hello", { files: [] });
    });
    expect(textarea.value).toBe("");
    localStorage.removeItem("fusion:chat-scope");
  });

  it("clears room composer on send button click after successful room send", async () => {
    localStorage.setItem("fusion:chat-scope", "rooms");
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
    setupMockRooms({
      activeRoom: {
        id: "room-001",
        projectId: "proj-123",
        name: "backend",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      sendRoomMessage,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "Room click hello");
    await userEvent.click(screen.getByTestId("chat-send-btn"));

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("Room click hello", { files: [] });
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
    localStorage.removeItem("fusion:chat-scope");
  });

  it("sends room attachments when the composer text is empty", async () => {
    localStorage.setItem("fusion:chat-scope", "rooms");
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
    setupMockRooms({
      activeRoom: {
        id: "room-001",
        projectId: "proj-123",
        name: "backend",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      sendRoomMessage,
    });

    try {
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const textFile = new File(["room"], "room.txt", { type: "text/plain" });
      fireEvent.change(fileInput, { target: { files: [textFile] } });

      expect(await screen.findByTestId("chat-attachment-previews")).toBeInTheDocument();
      const sendButton = screen.getByTestId("chat-send-btn");
      expect(sendButton).not.toBeDisabled();

      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(sendRoomMessage).toHaveBeenCalledWith("", { files: [textFile] });
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(screen.queryByTestId("chat-attachment-previews")).not.toBeInTheDocument();
    } finally {
      localStorage.removeItem("fusion:chat-scope");
    }
  });

  it("keeps direct chat send behavior unchanged when chat rooms are enabled", async () => {
    localStorage.setItem("fusion:chat-scope", "direct");
    const sendMessage = vi.fn();
    const sendRoomMessage = vi.fn();
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [],
      sendMessage,
    });
    setupMockRooms({ sendRoomMessage });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "Direct hello{enter}");

    expect(sendMessage).toHaveBeenCalledWith("Direct hello", []);
    expect(sendRoomMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
    localStorage.removeItem("fusion:chat-scope");
  });

  it("does not send on Shift+Enter", async () => {
    const sendMessage = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      sendMessage,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "Hello world{Shift>}{Enter}{/Shift}");

    expect(sendMessage).not.toHaveBeenCalled();
  });

  describe("attachments", () => {
    it("clicking paperclip triggers hidden file input", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, "click");

      await userEvent.click(screen.getByTestId("chat-attach-btn"));
      expect(clickSpy).toHaveBeenCalled();
    });

    it("allows attaching an image and sends with attachments only", async () => {
      const sendMessage = vi.fn();
      setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const attachButton = screen.getByTestId("chat-attach-btn");
      expect(attachButton).toBeInTheDocument();

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const imageFile = new File(["image"], "shot.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [imageFile] } });

      expect(await screen.findByTestId("chat-attachment-previews")).toBeInTheDocument();
      const sendButton = screen.getByTestId("chat-send-btn");
      expect(sendButton).not.toBeDisabled();

      await userEvent.click(sendButton);
      expect(sendMessage).toHaveBeenCalledWith("", [imageFile]);
      expect(screen.queryByTestId("chat-attachment-previews")).not.toBeInTheDocument();
    });

    it("accepts non-image files and renders filename preview", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const textFile = new File(["hello"], "note.txt", { type: "text/plain" });
      fireEvent.change(fileInput, { target: { files: [textFile] } });

      expect(await screen.findByText("note.txt")).toBeInTheDocument();
      expect(mockCreateObjectURL).not.toHaveBeenCalled();
    });

    it("adds image attachments from paste events", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      const imageFile = new File(["image"], "paste.png", { type: "image/png" });
      fireEvent.paste(textarea, { clipboardData: { files: [imageFile] } });

      expect(await screen.findByTestId("chat-attachment-previews")).toBeInTheDocument();
    });

    it("adds attachments from drag-and-drop", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const wrapper = document.querySelector(".chat-input-wrapper") as HTMLElement;
      const textFile = new File(["log"], "drop.log", { type: "text/x-log" });
      fireEvent.drop(wrapper, { dataTransfer: { files: [textFile] } });

      expect(await screen.findByText("drop.log")).toBeInTheDocument();
    });

    it("removes pending attachments and revokes preview urls", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const imageFile = new File(["image"], "shot.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [imageFile] } });

      const removeButton = await screen.findByTestId("chat-attachment-remove-0");
      await userEvent.click(removeButton);

      expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:shot.png");
      expect(screen.queryByTestId("chat-attachment-previews")).not.toBeInTheDocument();
    });

    it("renders message attachments inline as actionable links", async () => {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [
          {
            id: "msg-attach",
            sessionId: "session-001",
            role: "assistant",
            content: "Attached files",
            createdAt: "2026-04-08T00:00:00.000Z",
            attachments: [
              {
                id: "att-1",
                filename: "img-1.png",
                originalName: "capture.png",
                mimeType: "image/png",
                size: 10,
                createdAt: "2026-04-08T00:00:00.000Z",
              },
              {
                id: "att-2",
                filename: "note.txt",
                originalName: "note.txt",
                mimeType: "text/plain",
                size: 20,
                createdAt: "2026-04-08T00:00:00.000Z",
              },
            ],
          },
        ],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const links = screen.getAllByTestId("chat-message-attachment");
      expect(links).toHaveLength(2);
      expect(links[0]).toHaveAttribute("href", "/api/chat/sessions/session-001/attachments/img-1.png");
      expect(links[0]).toHaveAttribute("target", "_blank");
      expect(links[1]).toHaveAttribute("href", "/api/chat/sessions/session-001/attachments/note.txt");
      expect(screen.getByText("note.txt")).toBeInTheDocument();
    });
  });

  describe("agent mentions", () => {
    it("shows mention popup when @ is typed", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "@");

      expect(await screen.findByTestId("agent-mention-popup")).toBeInTheDocument();
    });

    it("filters mention popup by text after @", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "@be");

      expect(await screen.findByTestId("agent-mention-item-agent-002")).toBeInTheDocument();
      expect(screen.queryByTestId("agent-mention-item-agent-001")).not.toBeInTheDocument();
    });

    it("hides mention popup on Escape", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "@");
      expect(await screen.findByTestId("agent-mention-popup")).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("agent-mention-popup")).not.toBeInTheDocument();
    });

    it("inserts mention text when selecting an agent", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await userEvent.type(textarea, "@al");

      const mentionItem = await screen.findByTestId("agent-mention-item-agent-001");
      await userEvent.click(mentionItem);

      expect(textarea.value).toBe("@Alpha ");
      expect(screen.queryByTestId("agent-mention-popup")).not.toBeInTheDocument();
    });

    it("uses room member ordering in popup and marks non-member mention chips in room messages", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      setupMockRooms({
        activeRoom: {
          id: "room-001",
          slug: "engineering",
          name: "engineering",
          createdBy: "agent-001",
          status: "active",
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        activeRoomMembers: [
          { roomId: "room-001", agentId: "agent-001", role: "member", addedAt: "2026-04-08T00:00:00.000Z" },
        ],
        messages: [
          {
            id: "room-msg-1",
            roomId: "room-001",
            role: "user",
            content: "Ping @Alpha and @Beta",
            senderAgentId: "agent-001",
            metadata: null,
            attachments: [],
            mentions: ["agent-001", "agent-002"],
            createdAt: "2026-04-08T00:00:00.000Z",
          },
        ],
      });

      const allCss = await loadAllAppCss();
      const style = document.createElement("style");
      style.textContent = allCss;
      document.head.appendChild(style);

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByTestId("chat-sidebar-scope-rooms"));
      const textarea = screen.getByTestId("chat-input");
      await user.type(textarea, "@");

      expect(screen.getByTestId("agent-mention-members-header")).toBeInTheDocument();
      expect(screen.queryByTestId("agent-mention-others-header")).not.toBeInTheDocument();

      const bubble = screen.getByText("Ping", { exact: false }).closest(".chat-message--user");
      expect(bubble).toBeTruthy();

      const memberChip = screen.getByText("@Alpha", { selector: ".chat-mention-chip" });
      const nonMemberChip = screen.getByText("@Beta", { selector: ".chat-mention-chip--non-member" });
      expect(nonMemberChip).toHaveAttribute("title", "Not a member of engineering");

      // FN-4520: member mention chip text must not visually collapse into sent-bubble background.
      expect(getComputedStyle(memberChip).color).not.toBe(getComputedStyle(bubble as Element).backgroundColor);
      // FN-4520: non-member mention chip text must remain legible inside sent bubbles.
      expect(getComputedStyle(nonMemberChip).color).not.toBe(getComputedStyle(bubble as Element).backgroundColor);
    });

    it("renders assistant mentions as plain text in markdown mode", async () => {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [
          {
            id: "msg-001",
            sessionId: "session-001",
            role: "assistant",
            content: "Talk to @Alpha and @Unknown next.",
            createdAt: "2026-04-08T00:00:00.000Z",
          },
        ],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText(/Talk to @Alpha and @Unknown next\./)).toBeInTheDocument();
      });
      expect(screen.queryByText("@Alpha", { selector: ".chat-mention-chip" })).toBeNull();
      expect(screen.queryByText("@Unknown", { selector: ".chat-mention-chip" })).toBeNull();
    });
  });

  describe("slash skill autocomplete", () => {
    it("shows the skill menu when typing slash in the chat input", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-refactor", name: "refactor/code", relativePath: "skills/refactor/code.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");

      expect(await screen.findByTestId("chat-skill-menu")).toBeInTheDocument();
      expect(screen.getByText("refactor/code")).toBeInTheDocument();
    });

    it("filters discovered skills from slash input", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
        createMockSkill({ id: "skill-deploy", name: "deploy/app", relativePath: "skills/deploy/app.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/re");

      expect(await screen.findByText("review/pr")).toBeInTheDocument();
      expect(screen.queryByText("deploy/app")).not.toBeInTheDocument();
    });

    it("inserts /skill command when clicking a menu item", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/re");

      await userEvent.click(await screen.findByRole("option", { name: /review\/pr/i }));

      expect(textarea).toHaveValue("/skill:review/pr ");
      expect(screen.queryByTestId("chat-skill-menu")).not.toBeInTheDocument();
    });

    it("supports arrow navigation with wrapping and Enter selection", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-alpha", name: "alpha", relativePath: "skills/alpha.md" }),
        createMockSkill({ id: "skill-beta", name: "beta", relativePath: "skills/beta.md" }),
        createMockSkill({ id: "skill-gamma", name: "gamma", relativePath: "skills/gamma.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      fireEvent.change(textarea, { target: { value: "/" } });
      await screen.findByRole("option", { name: /alpha/i });

      // Wrap to bottom from the first item.
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /gamma/i })).toHaveClass(
          "chat-skill-menu-item--highlighted",
        ),
      );

      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(textarea).toHaveValue("/skill:gamma "));
    });

    it("keeps the keyboard highlight when revalidation re-delivers an identical skill list", async () => {
      // Regression: the SWR skills cache re-delivers content-identical lists
      // with fresh array identities (cache reads re-parse; revalidation
      // notifies a new array). The highlight reset must key on skill ids, not
      // array identity, or a revalidation landing mid-navigation wipes the
      // user's keyboard position (the source of this test family's CI flakes).
      const skillsList = [
        createMockSkill({ id: "skill-alpha", name: "alpha", relativePath: "skills/alpha.md" }),
        createMockSkill({ id: "skill-beta", name: "beta", relativePath: "skills/beta.md" }),
        createMockSkill({ id: "skill-gamma", name: "gamma", relativePath: "skills/gamma.md" }),
      ];
      // Seed the cache so the menu renders before the (deferred) revalidation fetch.
      writeCache(`${SWR_CACHE_KEYS.DISCOVERED_SKILLS_PREFIX}proj-123`, skillsList);
      let resolveFetch!: (skills: DiscoveredSkill[]) => void;
      mockFetchDiscoveredSkills.mockImplementationOnce(
        () => new Promise<DiscoveredSkill[]>((resolve) => { resolveFetch = resolve; }),
      );
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      fireEvent.change(textarea, { target: { value: "/" } });
      await screen.findByRole("option", { name: /alpha/i });

      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /gamma/i })).toHaveClass(
          "chat-skill-menu-item--highlighted",
        ),
      );

      // Revalidation lands mid-navigation: identical content, new identity.
      await act(async () => {
        resolveFetch(JSON.parse(JSON.stringify(skillsList)) as DiscoveredSkill[]);
      });

      expect(screen.getByRole("option", { name: /gamma/i })).toHaveClass(
        "chat-skill-menu-item--highlighted",
      );
    });

    it("supports selecting highlighted skill with Tab", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-alpha", name: "alpha", relativePath: "skills/alpha.md" }),
        createMockSkill({ id: "skill-beta", name: "beta", relativePath: "skills/beta.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");
      await screen.findByRole("option", { name: /alpha/i });

      await userEvent.keyboard("{ArrowDown}");
      expect(screen.getByRole("option", { name: /beta/i })).toHaveClass(
        "chat-skill-menu-item--highlighted",
      );

      await userEvent.keyboard("{Tab}");
      expect(textarea).toHaveValue("/skill:beta ");
    });

    it("closes the menu when pressing Escape", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");
      expect(await screen.findByTestId("chat-skill-menu")).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("chat-skill-menu")).not.toBeInTheDocument();
    });

    it("closes the menu when slash trigger pattern no longer matches", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/re");
      expect(await screen.findByTestId("chat-skill-menu")).toBeInTheDocument();

      await userEvent.type(textarea, " ");
      expect(screen.queryByTestId("chat-skill-menu")).not.toBeInTheDocument();
    });

    it("shows loading indicator while discovered skills are still loading", async () => {
      let resolveSkills: ((skills: DiscoveredSkill[]) => void) | undefined;
      mockFetchDiscoveredSkills.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSkills = resolve;
          }),
      );
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");

      expect(await screen.findByText("Loading skills…")).toBeInTheDocument();

      resolveSkills?.([createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" })]);
      await waitFor(() => {
        expect(screen.getByText("review/pr")).toBeInTheDocument();
      });
    });

    it("does not crash when discovered skills fail to load", async () => {
      mockFetchDiscoveredSkills.mockRejectedValueOnce(new Error("skills endpoint unavailable"));
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");

      expect(await screen.findByText("No skills available")).toBeInTheDocument();
    });
  });

  it("disables send button when input is empty", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sendButton = screen.getByTestId("chat-send-btn");
    expect(sendButton).toBeDisabled();
  });

  it("renders stop button when streaming", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: true,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-stop-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-send-btn")).not.toBeInTheDocument();
  });

  it("clicking stop button calls stopStreaming", async () => {
    const stopStreaming = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: true,
      stopStreaming,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-stop-btn"));
    expect(stopStreaming).toHaveBeenCalledTimes(1);
  });

  it("FN-6576 does not let a send gesture trailing click press the swapped stop button", async () => {
    const viewportSpy = mockViewportMode("mobile");
    const sendMessage = vi.fn();
    const stopStreaming = vi.fn();
    mockUseChat.mockImplementation(() => {
      const [isStreaming, setIsStreaming] = useState(false);
      return {
        ...defaultChatState,
        activeSession: activeSessionFixture,
        sessions: [activeSessionFixture],
        filteredSessions: [activeSessionFixture],
        messages: [],
        isStreaming,
        sendMessage: (message, files) => {
          sendMessage(message, files);
          setIsStreaming(true);
        },
        stopStreaming,
      } satisfies UseChatReturn;
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "Start streaming" } });
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("chat-send-btn"), { pointerType: "touch" });
      fireEvent.touchStart(screen.getByTestId("chat-send-btn"));
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("Start streaming", []);

    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-stop-btn"));
    });
    expect(stopStreaming).not.toHaveBeenCalled();
    viewportSpy.mockRestore();
  });

  it("FN-6576 allows a standalone mobile stop tap exactly once", async () => {
    const viewportSpy = mockViewportMode("mobile");
    const stopStreaming = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: true,
      stopStreaming,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("chat-stop-btn"), { pointerType: "touch" });
      fireEvent.touchStart(screen.getByTestId("chat-stop-btn"));
      fireEvent.click(screen.getByTestId("chat-stop-btn"));
    });
    expect(stopStreaming).toHaveBeenCalledTimes(1);
    viewportSpy.mockRestore();
  });

  it("FN-6576 allows a genuine stop tap within the send click-latch window", async () => {
    const viewportSpy = mockViewportMode("mobile");
    const sendMessage = vi.fn();
    const stopStreaming = vi.fn();
    mockUseChat.mockImplementation(() => {
      const [isStreaming, setIsStreaming] = useState(false);
      return {
        ...defaultChatState,
        activeSession: activeSessionFixture,
        sessions: [activeSessionFixture],
        filteredSessions: [activeSessionFixture],
        messages: [],
        isStreaming,
        sendMessage: (message, files) => {
          sendMessage(message, files);
          setIsStreaming(true);
        },
        stopStreaming,
      } satisfies UseChatReturn;
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "Start then stop" } });
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("chat-send-btn"), { pointerType: "touch" });
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("chat-stop-btn"), { pointerType: "touch" });
      fireEvent.touchStart(screen.getByTestId("chat-stop-btn"));
      fireEvent.click(screen.getByTestId("chat-stop-btn"));
    });
    expect(stopStreaming).toHaveBeenCalledTimes(1);
    viewportSpy.mockRestore();
  });

  it("renders send button when not streaming", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: false,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-send-btn")).toBeInTheDocument();
  });

  it("renders pending message indicator and dismisses it", async () => {
    const clearPendingMessage = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      pendingMessage: "Queued while streaming",
      clearPendingMessage,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-pending-indicator")).toHaveTextContent("Queued: Queued while streaming");

    await userEvent.click(screen.getByTestId("chat-pending-dismiss"));
    expect(clearPendingMessage).toHaveBeenCalledTimes(1);
  });

  it("textarea is enabled during streaming", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
      isStreaming: true,
      streamingText: "Thinking...",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    expect(textarea).not.toBeDisabled();
  });

  it("user can type while streaming", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
      isStreaming: true,
      streamingText: "Thinking...",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");

    // User should be able to type in the textarea while streaming
    fireEvent.change(textarea, { target: { value: "Second message" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Second message");
  });

  it("shows streaming indicator when isStreaming is true", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
      isStreaming: true,
      streamingText: "Typing...",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    // Streaming message should show
    const streamingMessage = document.querySelector(".chat-message--streaming") as HTMLElement | null;
    expect(streamingMessage).toBeInTheDocument();
    expect(streamingMessage?.textContent).toContain("Typing");
  });

  it("shows thinking blocks collapsed by default", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Here's my response", thinkingOutput: "I need to think about this...", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const message = screen.getByTestId("chat-message-msg-001");
    const details = message.querySelector("details");
    expect(details).toBeInTheDocument();
    expect(details).toHaveProperty("open", false);
  });

  describe("streaming states", () => {
    it("keeps mobile thread visible when active session metadata refreshes during streaming", async () => {
      const mediaQuerySpy = mockViewportMode("mobile");
      const streamingState: UseChatReturn = {
        ...defaultChatState,
        sessions: [{ ...activeSessionFixture }],
        filteredSessions: [{ ...activeSessionFixture }],
        activeSession: { ...activeSessionFixture },
        messages: [],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "",
      };
      const refreshedStreamingState: UseChatReturn = {
        ...streamingState,
        sessions: [{ ...activeSessionFixture, updatedAt: "2026-04-08T00:05:00.000Z" }],
        filteredSessions: [{ ...activeSessionFixture, updatedAt: "2026-04-08T00:05:00.000Z" }],
        activeSession: null,
      };

      mockUseChat
        .mockReturnValueOnce(streamingState)
        .mockReturnValue(refreshedStreamingState);

      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(document.querySelector(".chat-message--streaming")?.textContent).toContain("Working");
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(document.querySelector(".chat-message--streaming")?.textContent).toContain("Working");
      expect(screen.queryByText("Start a new conversation")).not.toBeInTheDocument();
      expect(screen.queryByText("No messages yet. Start the conversation!")).not.toBeInTheDocument();
      expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();

      void mediaQuerySpy;
    });

    it("keeps the streaming indicator visible while message history is still loading", async () => {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [],
        messagesLoading: true,
        isStreaming: true,
        streamingText: "",
        streamingThinking: "",
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const streamingMessage = document.querySelector(".chat-message--streaming") as HTMLElement | null;
      expect(streamingMessage).toBeInTheDocument();
      expect(streamingMessage?.textContent).toContain("Working");
      expect(screen.queryByText("Loading messages...")).not.toBeInTheDocument();
    });

    it("shows waiting indicator when streaming starts before text arrives", async () => {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "",
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Streaming message should show with "Working..." text
      const streamingMessage = document.querySelector(".chat-message--streaming") as HTMLElement | null;
      expect(streamingMessage).toBeInTheDocument();
      expect(streamingMessage?.textContent).toContain("Working");

      // Waiting class should be present
      const waitingContent = streamingMessage?.querySelector(".chat-message-content--waiting");
      expect(waitingContent).toBeInTheDocument();

      // Typing indicator dots should be rendered
      const typingIndicator = streamingMessage?.querySelector(".chat-typing-indicator");
      expect(typingIndicator).toBeInTheDocument();
      expect(typingIndicator?.querySelectorAll("span").length).toBe(3);
    });

    it("shows thinking indicator when streaming thinking arrives before text", async () => {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "analyzing the request...",
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Streaming message should show with "Thinking..." text
      const streamingMessage = document.querySelector(".chat-message--streaming") as HTMLElement | null;
      expect(streamingMessage).toBeInTheDocument();
      expect(streamingMessage?.textContent).toContain("Thinking");

      // Thinking details should be rendered
      const thinkingDetails = streamingMessage?.querySelector("details.chat-message-thinking");
      expect(thinkingDetails).toBeInTheDocument();
      expect(thinkingDetails?.querySelector(".chat-message-thinking-content")?.textContent).toContain("analyzing the request");

      // Typing indicator dots should be rendered
      const typingIndicator = streamingMessage?.querySelector(".chat-typing-indicator");
      expect(typingIndicator).toBeInTheDocument();
    });
  });

  it("filters sessions by search query", async () => {
    setupMockChat({
      sessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Frontend work", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "session-002", agentId: "agent-002", status: "active", title: "Backend API", createdAt: "2026-04-07T00:00:00.000Z", updatedAt: "2026-04-07T00:00:00.000Z" },
      ],
      filteredSessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Frontend work", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      ],
      searchQuery: "frontend",
      setSearchQuery: vi.fn(),
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Frontend work")).toBeInTheDocument();
    expect(screen.queryByText("Backend API")).not.toBeInTheDocument();
  });

  it("shows empty state with Start Chat button (no inline agent selector)", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    // Find the New Chat button in the empty state section
    const emptyStateText = screen.getByText("Start a new conversation");
    const emptyState = emptyStateText.closest(".chat-empty-state") as HTMLElement | null;
    expect(within(emptyState!).getByRole("button", { name: /new chat/i })).toBeInTheDocument();
    // Should NOT have an agent selector in empty state
    expect(emptyState?.querySelector("select")).toBeNull();
  });

  it("shows context menu on right-click", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");

    await userEvent.pointer({ target: sessionItem, keys: "[MouseRight]" });

    expect(screen.getByTestId("chat-context-archive")).toBeInTheDocument();
    expect(screen.getByTestId("chat-context-delete")).toBeInTheDocument();
  });

  it("calls archiveSession when clicking Archive in context menu", async () => {
    const archiveSession = vi.fn();
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      archiveSession,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    await userEvent.pointer({ target: sessionItem, keys: "[MouseRight]" });

    await userEvent.click(screen.getByTestId("chat-context-archive"));

    expect(archiveSession).toHaveBeenCalledWith("session-001");
  });

  it("shows delete confirmation dialog", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    await userEvent.pointer({ target: sessionItem, keys: "[MouseRight]" });

    await userEvent.click(screen.getByTestId("chat-context-delete"));

    // Dialog should be open
    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    expect(dialog).toBeInTheDocument();
    expect(within(dialog!).getByText("Delete Conversation?")).toBeInTheDocument();
  });

  it("shows formatted model label for fn agent sessions in sidebar", async () => {
    setupMockChat({
      sessions: [{
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "My Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        updatedAt: "2026-04-08T00:00:00.000Z",
        createdAt: "2026-04-08T00:00:00.000Z",
      }],
      filteredSessions: [{
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "My Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        updatedAt: "2026-04-08T00:00:00.000Z",
        createdAt: "2026-04-08T00:00:00.000Z",
      }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    expect(within(sessionItem).getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    expect(within(sessionItem).queryByText("Fusion")).not.toBeInTheDocument();
  });

  it("shows Fusion fallback for fn agent sessions in sidebar without model info", async () => {
    mockFetchModels.mockResolvedValue({
      models: [],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: null,
      defaultModelId: null,
    });
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "__fn_agent__", status: "active", title: "My Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "__fn_agent__", status: "active", title: "My Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    expect(within(sessionItem).getByText("Fusion")).toBeInTheDocument();
  });

  it("shows agent ID for non-fn agent sessions in sidebar", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "my-custom-agent", status: "active", title: "Custom Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "my-custom-agent", status: "active", title: "Custom Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    // Should show the agent ID (truncated to 30 chars)
    expect(within(sessionItem).getByText("my-custom-agent")).toBeInTheDocument();
  });

  it("shows formatted model name in thread header title for fn agent sessions", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const title = document.querySelector(".chat-thread-header-title") as HTMLElement | null;
    expect(title).toBeInTheDocument();
    expect(title).toHaveTextContent("Claude Sonnet 4.5");
    expect(title).not.toHaveTextContent("Fusion");
  });

  it("shows model tag in thread header when non-fn session has model", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "agent-001",
        status: "active",
        title: "Agent Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const headerModelTag = document.querySelector(".chat-thread-header .chat-model-tag") as HTMLElement | null;
    expect(headerModelTag).toBeInTheDocument();
    expect(headerModelTag?.textContent).toContain("Claude");
  });

  it("does not show duplicate model tag in thread header for fn agent sessions", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const title = document.querySelector(".chat-thread-header-title") as HTMLElement | null;
    expect(title).toHaveTextContent("Claude Sonnet 4.5");

    const headerModelTag = document.querySelector(".chat-thread-header .chat-model-tag") as HTMLElement | null;
    expect(headerModelTag).toBeNull();
  });

  it("keeps provider identity text grouped in header while render toggle stays on the same row", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "agent-001",
        status: "active",
        title: "Agent Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const header = document.querySelector(".chat-thread-header") as HTMLElement | null;
    const identity = screen.getByTestId("chat-thread-header-identity");
    const toggle = screen.getByTestId("chat-thread-render-toggle");
    const providerIcon = identity.querySelector(".provider-icon");
    const modelTag = identity.querySelector(".chat-model-tag");
    const newChatButton = screen.getByTestId("chat-thread-new-chat-btn");

    expect(header).toBeInTheDocument();
    expect(providerIcon).toBeInTheDocument();
    expect(within(identity).getByText("Agent Chat")).toBeInTheDocument();
    expect(modelTag).toBeInTheDocument();
    expect(modelTag).toHaveTextContent("Claude Sonnet 4.5");
    expect(toggle).toBeInTheDocument();
    expect(header?.children[header.children.length - 2]).toBe(toggle);
    expect(header?.children[header.children.length - 1]).toBe(newChatButton);
    expect(document.querySelectorAll(".chat-thread-header .chat-model-tag")).toHaveLength(1);
  });

  it("does not show model tag when session has no model", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test Chat",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag).not.toBeInTheDocument();
  });

  it("does not repeat the model tag in per-message avatars for non-fn sessions", async () => {
    // Per-message model tags were intentionally removed — the model is shown
    // once in the thread header. The avatar should still render with the
    // agent name (no agent identity collapse for real agents) but no model
    // tag inside it.
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "agent-001",
        status: "active",
        title: "Agent Chat",
        modelProvider: "openai",
        modelId: "gpt-4o",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-001");
    const avatar = messageBubble.querySelector(".chat-message-avatar") as HTMLElement | null;
    expect(avatar).toBeInTheDocument();
    expect(avatar?.querySelector(".chat-model-tag")).toBeNull();
  });

  it("hides per-message identity entirely for fn agent (model-only) sessions even when model is set", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test Chat",
        modelProvider: "openai",
        modelId: "gpt-4o",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-001");
    expect(messageBubble.querySelector(".chat-message-avatar")).toBeNull();
  });
});

describe("formatModelTag helper function", () => {
  // Import the function for testing - we'll test it via the UI behavior instead
  // The function is not exported, so we test it indirectly through the component

  it("formats claude-sonnet-4-5 model ID correctly", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "agent-001",
        status: "active",
        title: "Test",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag?.textContent).toContain("Claude Sonnet");
  });

  it("formats gpt-4o model ID correctly", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "agent-001",
        status: "active",
        title: "Test",
        modelProvider: "openai",
        modelId: "gpt-4o",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag?.textContent).toContain("GPT-4o");
  });

  it("formats gemini-2.5-pro model ID correctly", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "agent-001",
        status: "active",
        title: "Test",
        modelProvider: "google",
        modelId: "gemini-2.5-pro",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag?.textContent).toContain("Gemini");
  });

  it("returns null when modelId is missing", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test",
        modelProvider: "anthropic",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag).not.toBeInTheDocument();
  });

  it("returns null when provider is missing", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag).not.toBeInTheDocument();
  });
});

describe("Chat Session Delete Button", () => {
  it("renders delete button on each session item", async () => {
    setupMockChat({
      sessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat 1", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "session-002", agentId: "agent-002", status: "active", title: "Test Chat 2", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      ],
      filteredSessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat 1", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "session-002", agentId: "agent-002", status: "active", title: "Test Chat 2", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const deleteButtons = screen.getAllByTestId("chat-session-delete-btn");
    expect(deleteButtons.length).toBe(2);
  });

  it("clicking delete button shows confirmation dialog", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const deleteButton = screen.getByTestId("chat-session-delete-btn");
    await userEvent.click(deleteButton);

    // Dialog should be open
    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    expect(dialog).toBeInTheDocument();
    expect(within(dialog!).getByText("Delete Conversation?")).toBeInTheDocument();
  });

  it("clicking delete button does not select the session", async () => {
    const selectSession = vi.fn();
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      selectSession,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const deleteButton = screen.getByTestId("chat-session-delete-btn");
    await userEvent.click(deleteButton);

    expect(selectSession).not.toHaveBeenCalled();
  });

  it("renames from the desktop context menu with the current title prefilled", async () => {
    const renameSession = vi.fn().mockResolvedValue(undefined);
    const renamedSession: ChatSessionInfo = { id: "session-001", agentId: "agent-001", status: "active", title: "Renamed Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" };
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      renameSession,
    });

    const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.contextMenu(screen.getByTestId("chat-session-session-001"));
    expect(screen.getByTestId("chat-context-rename")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("chat-context-rename"));

    const input = screen.getByTestId("chat-rename-input") as HTMLInputElement;
    expect(input.value).toBe("Test Chat");
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed Chat");
    await userEvent.click(screen.getByTestId("chat-rename-save"));

    expect(renameSession).toHaveBeenCalledWith("session-001", "Renamed Chat");

    setupMockChat({
      activeSession: renamedSession,
      sessions: [renamedSession],
      filteredSessions: [renamedSession],
      renameSession,
    });
    await act(async () => {
      view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    });

    expect(screen.getByTestId("chat-session-session-001")).toHaveTextContent("Renamed Chat");
    const headerTitle = document.querySelector(".chat-thread-header-title") as HTMLElement | null;
    expect(headerTitle).toHaveTextContent("Renamed Chat");
  });

  it("prefills rename as empty for an untitled session and names it", async () => {
    const renameSession = vi.fn().mockResolvedValue(undefined);
    const untitledSession: ChatSessionInfo = { id: "session-001", agentId: "agent-001", status: "active", title: null, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" };
    setupMockChat({
      activeSession: untitledSession,
      sessions: [untitledSession],
      filteredSessions: [untitledSession],
      renameSession,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.contextMenu(screen.getByTestId("chat-session-session-001"));
    await userEvent.click(screen.getByTestId("chat-context-rename"));

    const input = screen.getByTestId("chat-rename-input") as HTMLInputElement;
    expect(input.value).toBe("");
    await userEvent.type(input, "Named from Untitled");
    await userEvent.click(screen.getByTestId("chat-rename-save"));

    expect(renameSession).toHaveBeenCalledWith("session-001", "Named from Untitled");
  });

  it("renames from the mobile session switcher and preserves the active header title surface", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    const renameSession = vi.fn().mockResolvedValue(undefined);
    try {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Mobile Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Mobile Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Mobile Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        renameSession,
      });

      const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(screen.getByTestId("chat-mobile-session-trigger")).toHaveTextContent("Mobile Chat");
      await userEvent.click(screen.getByTestId("chat-mobile-session-trigger"));
      await userEvent.click(screen.getByTestId("chat-mobile-session-rename-session-001"));

      const input = screen.getByTestId("chat-rename-input") as HTMLInputElement;
      expect(input.value).toBe("Mobile Chat");
      await userEvent.clear(input);
      await userEvent.type(input, "Mobile Renamed");
      await userEvent.click(screen.getByTestId("chat-rename-save"));

      expect(renameSession).toHaveBeenCalledWith("session-001", "Mobile Renamed");

      const renamedSession: ChatSessionInfo = { id: "session-001", agentId: "agent-001", status: "active", title: "Mobile Renamed", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" };
      setupMockChat({
        activeSession: renamedSession,
        sessions: [renamedSession],
        filteredSessions: [renamedSession],
        renameSession,
      });
      await act(async () => {
        view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      });

      expect(screen.getByTestId("chat-mobile-session-trigger")).toHaveTextContent("Mobile Renamed");
      const headerTitle = document.querySelector(".chat-thread-header-title") as HTMLElement | null;
      expect(headerTitle).toHaveTextContent("Mobile Renamed");
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("confirming delete calls deleteSession", async () => {
    const deleteSession = vi.fn();
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      deleteSession,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const deleteButton = screen.getByTestId("chat-session-delete-btn");
    await userEvent.click(deleteButton);

    // Click confirm in dialog
    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    await userEvent.click(within(dialog!).getByText("Delete"));

    expect(deleteSession).toHaveBeenCalledWith("session-001");
  });
});

describe("ChatView CSS — failure bubble contracts", () => {
  const css = loadAllAppCss();

  it("uses shared error surface tokens for failure bubbles and detail affordances", async () => {
    const bubbleMatch = css.match(/\.chat-message--failure\s*\{([^}]*)\}/);
    const badgeMatch = css.match(/\.chat-message-failure-badge\s*\{([^}]*)\}/);
    const detailsMatch = css.match(/\.chat-message-failure-details\s*\{([^}]*)\}/);
    const linkMatch = css.match(/\.chat-message-failure-reference-link\s*\{([^}]*)\}/);

    expect(bubbleMatch?.[1]).toContain("background: var(--status-error-bg)");
    expect(bubbleMatch?.[1]).toContain("border: var(--btn-border-width) solid var(--status-error-bg-deep)");
    expect(badgeMatch?.[1]).toContain("background: var(--status-error-bg-deep)");
    expect(detailsMatch?.[1]).toContain("background: var(--status-error-bg-deep)");
    expect(linkMatch?.[1]).toContain("background: var(--status-error-bg-deep)");
  });
});

describe("ChatView CSS — active state edge highlights", () => {
  const css = loadAllAppCss();

  function findRule(selector: string): string {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
    expect(match).toBeTruthy();
    return match?.[1] ?? "";
  }

  function mobileRuleContains(selector: string, propertyPattern: RegExp): boolean {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mobileRegex = /@media[^{}]*\(max-width:\s*768px\)[^{]*\{([\s\S]*?)\n\}/g;
    let match;
    while ((match = mobileRegex.exec(css)) !== null) {
      const ruleMatch = match[1].match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
      if (ruleMatch && propertyPattern.test(ruleMatch[1])) {
        return true;
      }
    }
    return false;
  }

  it("keeps scope-tab active tint without the removed bottom underline", async () => {
    const activeScopeRule = findRule(".chat-sidebar-scope-btn--active");

    expect(activeScopeRule).toContain("background: var(--card)");
    expect(activeScopeRule).toContain("color: var(--text)");
    expect(activeScopeRule).not.toContain("box-shadow");
    expect(activeScopeRule).not.toContain("inset");
  });

  it("keeps active chat-row background without the removed left edge or offset", async () => {
    const activeSessionRule = findRule(".chat-session-item--active");

    expect(activeSessionRule).toContain("background: color-mix(in srgb, var(--todo) 12%, transparent)");
    expect(activeSessionRule).not.toContain("border-left");
    expect(activeSessionRule).not.toContain("padding-left: calc(var(--space-md) - (var(--btn-border-width) * 3))");
  });

  it("does not reintroduce either removed highlight in mobile rules", async () => {
    expect(mobileRuleContains(".chat-sidebar-scope-btn--active", /box-shadow\s*:\s*inset/)).toBe(false);
    expect(mobileRuleContains(".chat-session-item--active", /border-left\s*:/)).toBe(false);
    expect(mobileRuleContains(".chat-session-item--active", /padding-left\s*:\s*calc\(var\(--space-md\)\s*-\s*\(var\(--btn-border-width\)\s*\*\s*3\)\)/)).toBe(false);
  });
});

describe("FN-3911 chat session list layout", () => {
  const css = loadAllAppCss();

  it("reserves right padding on title and preview rows so text clears the delete button", async () => {
    const titleMatch = css.match(/\.chat-session-title\s*\{([^}]*)\}/);
    const previewMatch = css.match(/\.chat-session-preview\s*\{([^}]*)\}/);
    expect(titleMatch).toBeTruthy();
    expect(previewMatch).toBeTruthy();
    expect(titleMatch?.[1]).toMatch(/padding-right:\s*calc\(var\(--space-md\)\s*\*\s*3\)/);
    expect(previewMatch?.[1]).toMatch(/padding-right:\s*calc\(var\(--space-md\)\s*\*\s*3\)/);
  });

  it("FN-4385: keeps mobile title/preview clearance matched to compact delete button", async () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-session-title,\s*\.chat-session-preview\s*\{\s*padding-right:\s*calc\(var\(--space-md\)\s*\*\s*3\);\s*\}/,
    );
  });
});

describe("Chat Session Delete Button CSS", () => {
  const css = loadAllAppCss();

  it(".chat-session-delete-btn exists with opacity: 0", async () => {
    const match = css.match(/\.chat-session-delete-btn\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("opacity: 0");
  });

  it(".chat-session-item:hover .chat-session-delete-btn has opacity: 1", async () => {
    const match = css.match(/\.chat-session-item:hover\s*\.chat-session-delete-btn\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("opacity: 1");
  });

  it("FN-4352: mobile delete button stays visible without min-size inflation", async () => {
    const mobileRegex = /@media[^{]*\(max-width:\s*768px\)[^{]*\{([\s\S]*?)\n\}/g;
    let match;
    let deleteRule = "";
    while ((match = mobileRegex.exec(css)) !== null) {
      const mediaContent = match[1];
      if (mediaContent.includes(".chat-session-delete-btn")) {
        deleteRule = mediaContent.match(/\.chat-session-delete-btn\s*\{([^}]*)\}/)?.[1] ?? "";
        if (deleteRule) break;
      }
    }

    expect(deleteRule).toContain("opacity: 1");
    expect(deleteRule).not.toContain("min-width:");
    expect(deleteRule).not.toContain("min-height:");
  });
});

describe("ChatView CSS — mobile thread switcher", () => {
  const css = loadAllAppCss();

  it("includes mobile session switcher trigger and dropdown tokenized contracts", async () => {
    const triggerMatch = css.match(/\.chat-mobile-session-trigger\s*\{([^}]*)\}/);
    const triggerIconMatch = css.match(/\.chat-mobile-session-trigger\s*>\s*svg\s*\{([^}]*)\}/);
    const dropdownMatch = css.match(/\.chat-mobile-session-dropdown\s*\{([^}]*)\}/);
    const optionMatch = css.match(/\.chat-mobile-session-option\s*\{([^}]*)\}/);
    const optionTitleMatch = css.match(/\.chat-mobile-session-option-title\s*\{([^}]*)\}/);
    expect(triggerMatch).toBeTruthy();
    expect(triggerIconMatch).toBeTruthy();
    expect(dropdownMatch).toBeTruthy();
    expect(optionMatch).toBeTruthy();
    expect(optionTitleMatch).toBeTruthy();
    expect(triggerMatch?.[1]).toContain("min-height: calc(var(--space-lg) * 2 + var(--space-xs))");
    expect(triggerMatch?.[1]).toContain("min-width: 0");
    expect(triggerMatch?.[1]).toContain("padding: var(--space-xs) var(--space-sm)");
    expect(triggerMatch?.[1]).toContain("font: inherit");
    expect(triggerMatch?.[1]).toContain("line-height: normal");
    expect(triggerMatch?.[1]).toContain("text-align: left");
    expect(triggerIconMatch?.[1]).toContain("width: var(--icon-size-md)");
    expect(triggerIconMatch?.[1]).toContain("height: var(--icon-size-md)");
    expect(dropdownMatch?.[1]).toContain("background: var(--surface)");
    expect(dropdownMatch?.[1]).toContain("border: 1px solid var(--border)");
    expect(optionMatch?.[1]).toContain("min-height: calc(var(--space-lg) * 2.25)");
    expect(optionMatch?.[1]).toContain("align-items: flex-start");
    expect(optionMatch?.[1]).toContain("line-height: normal");
    expect(optionTitleMatch?.[1]).toContain("display: block");
    expect(optionTitleMatch?.[1]).toContain("line-height: normal");
    expect(optionTitleMatch?.[1]).toContain("white-space: normal");
    expect(optionTitleMatch?.[1]).toContain("overflow-wrap: anywhere");
  });

  it("keeps mobile override for header identity overflow visible so dropdown can render", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread-header-identity\s*\{[^}]*overflow:\s*visible;/);
  });
});

describe("ChatView CSS — nested flexbox scrolling fix", () => {
  const css = loadAllAppCss();

  it(".chat-session-list has min-height: 0 for proper vertical scrolling", async () => {
    const match = css.match(/\.chat-session-list\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("min-height: 0");
  });

  it(".chat-thread has min-height: 0 for proper vertical scrolling", async () => {
    const match = css.match(/\.chat-thread\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("min-height: 0");
  });

  it(".chat-messages has min-height: 0 for proper vertical scrolling", async () => {
    const match = css.match(/\.chat-messages\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("min-height: 0");
  });
});

describe("ChatView project-scoped agent fetching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchDiscoveredSkills.mockResolvedValue([]);
  });

  it("passes projectId to fetchAgents in agent name resolution effect", async () => {
    // Mock useChat to return empty agentsMap so ChatView fetches its own
    setupMockChat({ agentsMap: new Map() });

    await renderWithAct(<ChatView projectId="proj-456" addToast={vi.fn()} />);

    await waitFor(() => {
      expect(apiModule.fetchAgents).toHaveBeenCalledWith(undefined, "proj-456");
    });
  });

  it("passes projectId to NewChatDialog for agent selection", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-789" addToast={vi.fn()} />);

    // Open the new chat dialog
    await userEvent.click(screen.getByTestId("chat-new-btn"));

    // The dialog should have been rendered with projectId
    // We verify the mock fetchAgents was called with the correct projectId
    await waitFor(() => {
      expect(apiModule.fetchAgents).toHaveBeenCalledWith(undefined, "proj-789");
    });
  });

  it("refetches agents when projectId changes in ChatView", async () => {
    // First render with proj-001
    setupMockChat({ agentsMap: new Map() });
    const { rerender } = await renderWithAct(<ChatView projectId="proj-001" addToast={vi.fn()} />);

    await waitFor(() => {
      expect(apiModule.fetchAgents).toHaveBeenCalledWith(undefined, "proj-001");
    });

    const callsBeforeRerender = vi.mocked(apiModule.fetchAgents).mock.calls.length;

    // Rerender with proj-002
    rerender(<ChatView projectId="proj-002" addToast={vi.fn()} />);

    await waitFor(() => {
      expect(apiModule.fetchAgents).toHaveBeenCalledWith(undefined, "proj-002");
    });

    // Should have made an additional fetch call
    expect(vi.mocked(apiModule.fetchAgents).mock.calls.length).toBeGreaterThan(callsBeforeRerender);
  });

  it("refetches agents when projectId changes in NewChatDialog", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    const { rerender } = await renderWithAct(<ChatView projectId="proj-001" addToast={vi.fn()} />);

    // Open dialog and check initial projectId
    await userEvent.click(screen.getByTestId("chat-new-btn"));
    await waitFor(() => {
      expect(apiModule.fetchAgents).toHaveBeenCalledWith(undefined, "proj-001");
    });

    // Close dialog, change projectId, reopen
    // Note: we need to trigger a new dialog render with the new projectId
    rerender(<ChatView projectId="proj-002" addToast={vi.fn()} />);

    // Close and reopen dialog
    const closeBtn = document.querySelector(".chat-new-dialog-backdrop") as HTMLElement | null;
    if (closeBtn) {
      await userEvent.click(closeBtn);
    }

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    await waitFor(() => {
      expect(apiModule.fetchAgents).toHaveBeenCalledWith(undefined, "proj-002");
    });
  });
});

describe("ChatView sidebar structure", () => {
  it("renders sidebar sections without an empty header spacer", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(document.querySelector(".chat-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".chat-sidebar-search")).toBeInTheDocument();
    expect(document.querySelector(".chat-sidebar-list")).toBeInTheDocument();
    expect(document.querySelector(".chat-sidebar-footer")).toBeInTheDocument();
    expect(document.querySelector(".chat-sidebar-header")).not.toBeInTheDocument();
  });

  it("renders desktop header New Chat button", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-new-btn")).toBeInTheDocument();
  });

  it("renders mobile footer New Chat button in Direct scope", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });
    const viewportSpy = mockViewportMode("mobile");

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-new-btn")).toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("hides mobile footer New Chat button in Rooms scope", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });
    const viewportSpy = mockViewportMode("mobile");

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    expect(screen.queryByTestId("chat-new-btn")).not.toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("opens new chat dialog when clicking mobile footer New Chat button in Direct scope", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });
    const viewportSpy = mockViewportMode("mobile");

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    expect(dialog).toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("session list has both chat-session-list and chat-sidebar-list classes", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionList = document.querySelector(".chat-session-list") as HTMLElement | null;
    expect(sessionList).toBeInTheDocument();
    expect(sessionList).toHaveClass("chat-sidebar-list");
  });
});

describe("room creation", () => {
  it("opens the newly created room and collapses the mobile sidebar on success", async () => {
    const { createRoom, viewportSpy } = await renderRoomCreation({ viewport: "mobile" });

    expect(createRoom).toHaveBeenCalledWith({ name: "newroom", memberAgentIds: ["agent-001"] });
    expect(document.querySelector(".chat-sidebar")).toHaveClass("chat-sidebar--hidden");
    expect(screen.queryByRole("dialog", { name: "Create room" })).toBeNull();
    expect(within(document.querySelector(".chat-room-thread-header") as HTMLElement).getByText("#newroom")).toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("opens the newly created room on desktop without hiding the sidebar", async () => {
    const { createRoom, viewportSpy } = await renderRoomCreation({ viewport: "desktop" });

    expect(createRoom).toHaveBeenCalledWith({ name: "newroom", memberAgentIds: ["agent-001"] });
    expect(document.querySelector(".chat-sidebar")).not.toHaveClass("chat-sidebar--hidden");
    expect(screen.queryByRole("dialog", { name: "Create room" })).toBeNull();
    expect(within(document.querySelector(".chat-room-thread-header") as HTMLElement).getByText("#newroom")).toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("keeps the modal open and sidebar visible when room creation fails", async () => {
    const { createRoom, viewportSpy } = await renderRoomCreation({ viewport: "mobile", createRejects: true });

    expect(createRoom).toHaveBeenCalledWith({ name: "newroom", memberAgentIds: ["agent-001"] });
    expect(screen.getByRole("dialog", { name: "Create room" })).toBeInTheDocument();
    expect(document.querySelector(".chat-sidebar")).not.toHaveClass("chat-sidebar--hidden");
    expect(screen.queryByText("#newroom")).toBeNull();

    viewportSpy.mockRestore();
  });
});

describe("Direct/Rooms scope toggle", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("hides rooms UI when chatRooms experimental flag is off", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{}} />);

    expect(screen.queryByTestId("chat-sidebar-scope-rooms")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-sidebar-rooms")).not.toBeInTheDocument();
  });

  it("defaults to Direct with sidebar list visible", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.getByTestId("chat-sidebar-scope-direct")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("chat-sidebar-scope-rooms")).toHaveAttribute("aria-selected", "false");
    expect(document.querySelector(".chat-session-list")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-sidebar-rooms-empty")).toBeNull();
  });

  it("shows rooms UI when chatRooms experimental flag is on", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.getByTestId("chat-sidebar-scope-rooms")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    expect(screen.getByTestId("chat-sidebar-rooms")).toBeInTheDocument();
  });

  it("shows rooms placeholder and hides direct search/list in Rooms scope", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));

    expect(screen.getByTestId("chat-sidebar-scope-rooms")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("chat-sidebar-rooms-empty")).toBeInTheDocument();
    expect(document.querySelector(".chat-session-list")).toBeNull();
    expect(screen.queryByTestId("chat-search-input")).toBeNull();
  });

  it("switching back to Direct restores search/list and keeps active session highlight", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-direct"));

    expect(screen.getByTestId("chat-search-input")).toBeInTheDocument();
    expect(document.querySelector(".chat-session-list")).toBeInTheDocument();
    expect(screen.getByTestId("chat-session-session-001")).toHaveClass("chat-session-item--active");
  });

  it("FN-4327: switching scope from Rooms to Direct re-anchors direct thread", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
    Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1200 });
    Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
    let scrollTopValue = 500;
    Object.defineProperty(messagesContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    fireEvent.scroll(messagesContainer);
    expect(screen.getByTestId("chat-jump-to-latest")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-direct"));

    await waitFor(() => {
      expect(scrollTopValue).toBe(1200);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();
    });
  });

  it("forces direct scope when localStorage persisted rooms but chatRooms is off", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });
    localStorage.setItem("fusion:chat-scope", "rooms");

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{}} />);

    expect(screen.queryByTestId("chat-sidebar-scope-rooms")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-search-input")).toBeInTheDocument();
  });

  it("persists scope in localStorage and restores Rooms on next mount", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    const { unmount } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    expect(localStorage.getItem("fusion:chat-scope")).toBe("rooms");

    unmount();

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.getByTestId("chat-sidebar-scope-rooms")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("chat-sidebar-rooms-empty")).toBeInTheDocument();
  });
});

describe("FN-5380 scroll preservation", () => {
  beforeEach(() => {
    mockFetchModels.mockImplementation(() => new Promise(() => {}));
  });

  const makeMessages = (count: number, sessionId = "session-001") =>
    Array.from({ length: count }, (_, index) => ({
      id: `msg-${index + 1}`,
      sessionId,
      role: index % 2 === 0 ? "assistant" : "user",
      content: `Message ${index + 1}`,
      createdAt: `2026-04-08T00:00:${String(index).padStart(2, "0")}.000Z`,
    } satisfies ChatMessageInfo));

  const attachScrollGeometry = (container: HTMLDivElement, initialTop: number, height = 2000) => {
    let scrollTopValue = initialTop;
    Object.defineProperty(container, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(container, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    return () => scrollTopValue;
  };

  it("preserves scroll across silent reconnect-style refetch for direct chats", async () => {
    const baseMessages = makeMessages(30);
    setupMockChat({ activeSession: activeSessionFixture, messages: baseMessages });

    const view = rtlRender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    const readScrollTop = attachScrollGeometry(container, 760);

    fireEvent.scroll(container);

    setupMockChat({ activeSession: activeSessionFixture, messages: [...baseMessages] });
    view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await waitFor(() => {
      expect(readScrollTop()).toBe(760);
    });
  });

  it("auto-scrolls on new message only when previously pinned", async () => {
    const baseMessages = makeMessages(4);
    setupMockChat({ activeSession: activeSessionFixture, messages: baseMessages });

    const view = rtlRender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    const readScrollTop = attachScrollGeometry(container, 1700);

    fireEvent.scroll(container);
    setupMockChat({ activeSession: activeSessionFixture, messages: [...baseMessages, ...makeMessages(1).map((message) => ({ ...message, id: "msg-5" }))] });
    view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await waitFor(() => {
      expect(readScrollTop()).toBe(2000);
    });

    container.scrollTop = 500;
    fireEvent.scroll(container);

    setupMockChat({ activeSession: activeSessionFixture, messages: makeMessages(6) });
    view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await waitFor(() => {
      expect(readScrollTop()).toBe(500);
    });
  });

  it("preserves scroll through visibility reconnect path", async () => {
    const baseMessages = makeMessages(20);
    setupMockChat({ activeSession: activeSessionFixture, messages: baseMessages });

    const view = rtlRender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    const readScrollTop = attachScrollGeometry(container, 640);

    fireEvent.scroll(container);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));

    setupMockChat({ activeSession: activeSessionFixture, messages: [...baseMessages, ...makeMessages(1).map((message) => ({ ...message, id: "msg-21" }))] });
    view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await waitFor(() => {
      expect(readScrollTop()).toBe(640);
    });
  });

  it("preserves room transcript scroll on message refresh", async () => {
    const room = createRoomFixture("ops");
    const roomMessages = makeMessages(12, room.id).map((message) => ({
      id: message.id,
      roomId: room.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      senderAgentId: null,
      thinkingOutput: null,
      metadata: null,
      mentions: [],
    }));

    setupMockChat({ sessions: [], filteredSessions: [] });
    setupMockRooms({ rooms: [room], activeRoom: room, messages: roomMessages, messagesLoading: false });

    const view = rtlRender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    const readScrollTop = attachScrollGeometry(container, 420);
    fireEvent.scroll(container);

    setupMockRooms({ rooms: [room], activeRoom: room, messages: [...roomMessages], messagesLoading: false });
    view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await waitFor(() => {
      expect(readScrollTop()).toBe(420);
    });
  });
});

describe("FN-5720 room re-entry anchoring", () => {
  beforeEach(() => {
    mockFetchModels.mockImplementation(() => new Promise(() => {}));
  });

  const makeMessages = (count: number, sessionId = "session-001") =>
    Array.from({ length: count }, (_, index) => ({
      id: `msg-${index + 1}`,
      sessionId,
      role: index % 2 === 0 ? "assistant" : "user",
      content: `Message ${index + 1}`,
      createdAt: `2026-04-08T00:00:${String(index).padStart(2, "0")}.000Z`,
    } satisfies ChatMessageInfo));

  const attachScrollGeometry = (container: HTMLDivElement, initialTop: number, height = 2000) => {
    let scrollTopValue = initialTop;
    Object.defineProperty(container, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(container, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    return () => scrollTopValue;
  };

  const makeRoomMessages = (roomId: string, count: number) =>
    makeMessages(count, roomId).map((message) => ({
      id: message.id,
      roomId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      senderAgentId: null,
      thinkingOutput: null,
      metadata: null,
      mentions: [],
    }));

  it("anchors to bottom when re-entering Rooms scope", async () => {
    const room = createRoomFixture("ops");
    const roomMessages = makeRoomMessages(room.id, 12);

    setupMockChat({
      activeSession: activeSessionFixture,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      messages: [{ id: "dm-1", sessionId: activeSessionFixture.id, role: "assistant", content: "Direct", createdAt: "2026-04-08T00:00:00.000Z" }],
    });
    setupMockRooms({ rooms: [room], activeRoom: room, messages: roomMessages, messagesLoading: false });
    localStorage.setItem("fusion:chat-scope", "rooms");

    rtlRender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    const readScrollTop = attachScrollGeometry(container, 420);

    container.scrollTop = 420;
    fireEvent.scroll(container);

    await userEvent.click(screen.getByTestId("chat-sidebar-scope-direct"));
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));

    await waitFor(() => {
      expect(readScrollTop()).toBe(2000);
    });
  });

  it("preserves scrolled-up room position on message refetch", async () => {
    const room = createRoomFixture("ops");
    const roomMessages = makeRoomMessages(room.id, 10);

    setupMockChat({ sessions: [], filteredSessions: [] });
    setupMockRooms({ rooms: [room], activeRoom: room, messages: roomMessages, messagesLoading: false });

    const view = rtlRender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    const readScrollTop = attachScrollGeometry(container, 380);
    fireEvent.scroll(container);

    setupMockRooms({ rooms: [room], activeRoom: room, messages: [...roomMessages], messagesLoading: false });
    view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await waitFor(() => {
      expect(readScrollTop()).toBe(380);
    });
  });
});

describe("resizable sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders desktop resize handle with separator ARIA attributes", async () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const handle = screen.getByRole("separator", { name: "Resize chat sidebar" });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuemin", "180");
    expect(handle).toHaveAttribute("aria-valuemax", "500");
    expect(handle).toHaveAttribute("aria-valuenow", "280");
    expect(handle).toHaveAttribute("tabindex", "0");

    viewportSpy.mockRestore();
  });

  it("updates sidebar width while dragging", async () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const handle = screen.getByRole("separator", { name: "Resize chat sidebar" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 280 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 360 });

    const sidebar = document.querySelector(".chat-sidebar") as HTMLElement;
    expect(sidebar.style.width).toBe("360px");
    expect(handle).toHaveAttribute("aria-valuenow", "360");

    viewportSpy.mockRestore();
  });

  it("clamps width between min and max", async () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const handle = screen.getByRole("separator", { name: "Resize chat sidebar" });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 280 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: -1000 });
    expect((document.querySelector(".chat-sidebar") as HTMLElement).style.width).toBe("180px");

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 280 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 2000 });
    expect((document.querySelector(".chat-sidebar") as HTMLElement).style.width).toBe("500px");

    viewportSpy.mockRestore();
  });

  it("persists width to localStorage on pointer up", async () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const handle = screen.getByRole("separator", { name: "Resize chat sidebar" });
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 280 });
      fireEvent.pointerMove(document, { pointerId: 1, clientX: 360 });
      fireEvent.pointerUp(document, { pointerId: 1, clientX: 360 });
    });

    expect(localStorage.getItem("fusion:chat-sidebar-width")).toBe("360");

    viewportSpy.mockRestore();
  });

  it("restores persisted width on mount", async () => {
    const viewportSpy = mockViewportMode("desktop");
    localStorage.setItem("fusion:chat-sidebar-width", "350");
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect((document.querySelector(".chat-sidebar") as HTMLElement).style.width).toBe("350px");

    viewportSpy.mockRestore();
  });

  it("does not render resize handle on mobile", async () => {
    const viewportSpy = mockViewportMode("mobile");
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByRole("separator", { name: "Resize chat sidebar" })).toBeNull();

    viewportSpy.mockRestore();
  });
});

describe("thread header New Chat button", () => {
  const activeSession = { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" };

  it("renders New Chat button in thread header on desktop when session is active", async () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ activeSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const btn = screen.getByTestId("chat-thread-new-chat-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("New Chat");
    expect(btn).toHaveClass("btn", "btn-sm", "btn-primary");

    viewportSpy.mockRestore();
  });

  it("clicking thread header New Chat button opens the NewChatDialog", async () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ activeSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const btn = screen.getByTestId("chat-thread-new-chat-btn");
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(await screen.findByTestId("chat-new-dialog-mode-toggle")).toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("does not render New Chat button in thread header on mobile", async () => {
    const viewportSpy = mockViewportMode("mobile");
    setupMockChat({ activeSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-thread-new-chat-btn")).toBeNull();

    viewportSpy.mockRestore();
  });
});

describe("ChatView mobile behavior", () => {
  let savedVisualViewport: typeof window.visualViewport;
  let savedInnerHeight: number;
  let savedOntouchstart: typeof window.ontouchstart;

  beforeEach(() => {
    _resetInitialViewportHeight();
    savedVisualViewport = window.visualViewport;
    savedInnerHeight = window.innerHeight;
    savedOntouchstart = window.ontouchstart;
  });

  afterEach(() => {
    _resetInitialViewportHeight();
    Object.defineProperty(window, "visualViewport", {
      value: savedVisualViewport,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: savedInnerHeight,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "ontouchstart", {
      value: savedOntouchstart,
      writable: true,
      configurable: true,
    });
  });

  function mockMobileVisualViewport({
    innerHeight,
    vvHeight,
  }: {
    innerHeight: number;
    vvHeight: number;
  }) {
    (window as any).ontouchstart = null;
    Object.defineProperty(window, "innerHeight", {
      value: innerHeight,
      writable: true,
      configurable: true,
    });

    const listeners: Record<string, Array<() => void>> = {
      resize: [],
      scroll: [],
    };

    const mockVV = {
      width: 375,
      height: vvHeight,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        listeners[event]?.push(cb);
      }),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(window, "visualViewport", {
      value: mockVV,
      writable: true,
      configurable: true,
    });

    return { listeners, mockVV };
  }
  function ensureMatchMedia() {
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn(),
      });
    }
  }

  function mockMobileViewport() {
    ensureMatchMedia();
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
    return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  function mockDesktopViewport() {
    ensureMatchMedia();
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  it("mobile mode: does not render thread header when no active session (list view)", async () => {
    const restoreMatchMedia = mockMobileViewport();
    try {
      setupMockChat({
        sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        activeSession: null,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Thread header should not be rendered when there's no active session
      expect(document.querySelector(".chat-thread-header")).not.toBeInTheDocument();
      // Back button should not be visible
      expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: renders thread header with back button when session is active", async () => {
    const restoreMatchMedia = mockMobileViewport();
    try {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Thread header should be rendered when there's an active session
      expect(document.querySelector(".chat-thread-header")).toBeInTheDocument();
      // Back button should be visible in mobile thread view
      expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: tapping back button calls selectSession with empty string to return to list", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const selectSession = vi.fn();
    try {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
        selectSession,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const backBtn = screen.getByTestId("chat-back-btn");
      await userEvent.click(backBtn);

      // Back button should trigger selectSession("") to return to list view
      expect(selectSession).toHaveBeenCalledWith("");
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: thread header title opens quick session switcher and closes after selection", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const selectSession = vi.fn();
    try {
      setupMockChat({
        sessions: [
          { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
          { id: "session-002", agentId: "agent-002", status: "active", title: "Another Chat", createdAt: "2026-04-07T00:00:00.000Z", updatedAt: "2026-04-07T00:00:00.000Z" },
        ],
        filteredSessions: [
          { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
          { id: "session-002", agentId: "agent-002", status: "active", title: "Another Chat", createdAt: "2026-04-07T00:00:00.000Z", updatedAt: "2026-04-07T00:00:00.000Z" },
        ],
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        selectSession,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const trigger = screen.getByTestId("chat-mobile-session-trigger");
      expect(trigger).toHaveClass("btn", "chat-mobile-session-trigger");
      expect(trigger).not.toHaveClass("btn-icon");
      expect(trigger).toHaveTextContent("Test Chat");

      await userEvent.click(trigger);
      expect(screen.getByTestId("chat-mobile-session-dropdown")).toBeInTheDocument();

      await userEvent.click(screen.getByTestId("chat-mobile-session-option-session-002"));
      expect(selectSession).toHaveBeenCalledWith("session-002");
      expect(screen.queryByTestId("chat-mobile-session-dropdown")).not.toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: quick session switcher closes on outside click and is not shown for rooms", async () => {
    const restoreMatchMedia = mockMobileViewport();
    try {
      setupMockChat({ activeSession: activeSessionFixture });
      const initialRender = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(screen.queryByTestId("chat-mobile-session-trigger")).toBeInTheDocument();
      await userEvent.click(screen.getByTestId("chat-mobile-session-trigger"));
      expect(screen.getByTestId("chat-mobile-session-dropdown")).toBeInTheDocument();

      fireEvent.mouseDown(document.body);
      await waitFor(() => {
        expect(screen.queryByTestId("chat-mobile-session-dropdown")).not.toBeInTheDocument();
      });

      initialRender.unmount();

      localStorage.setItem("fusion:chat-scope", "rooms");
      setupMockRooms({
        activeRoom: {
          id: "room-001",
          projectId: "proj-123",
          name: "backend",
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
      expect(screen.queryByTestId("chat-mobile-session-trigger")).not.toBeInTheDocument();
      expect(screen.getByText("#backend")).toBeInTheDocument();
    } finally {
      localStorage.setItem("fusion:chat-scope", "direct");
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: iOS first tap focuses direct composer without blocking native focus, then sends", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const isIOSSpy = vi.spyOn(mobileScrollLock, "isIOS").mockReturnValue(true);
    const sendMessage = vi.fn();

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [],
        sendMessage,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      input.blur();
      expect(document.activeElement).not.toBe(input);

      const touchEvent = new TouchEvent("touchstart", { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(touchEvent, "preventDefault");
      fireEvent(input, touchEvent);
      // jsdom has no soft keyboard/native touch-focus default action; mirror
      // the browser focus that iOS only performs when touchstart is not canceled.
      if (!touchEvent.defaultPrevented) {
        input.focus();
      }

      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);

      fireEvent.change(input, { target: { value: "Hello mobile" } });
      const sendButton = screen.getByTestId("chat-send-btn");
      fireEvent.touchStart(sendButton);
      fireEvent.click(sendButton);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith("Hello mobile", []);
      expect(document.activeElement).toBe(input);
    } finally {
      isIOSSpy.mockRestore();
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: send button sends on first touch and keeps composer focused", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const sendMessage = vi.fn();

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [],
        sendMessage,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "Hello mobile" } });
      input.focus();

      const sendButton = screen.getByTestId("chat-send-btn");
      fireEvent.touchStart(sendButton);
      fireEvent.click(sendButton);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith("Hello mobile", []);
      expect(document.activeElement).toBe(input);
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: room send button sends on first touch and keeps composer focused", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn();

    try {
      localStorage.setItem("fusion:chat-scope", "rooms");
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [],
        sendMessage,
      });
      setupMockRooms({
        activeRoom: {
          id: "room-001",
          projectId: "proj-123",
          name: "backend",
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        sendRoomMessage,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "Hello mobile room" } });
      input.focus();

      const sendButton = screen.getByTestId("chat-send-btn");
      fireEvent.touchStart(sendButton);
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(sendRoomMessage).toHaveBeenCalledTimes(1);
        expect(sendRoomMessage).toHaveBeenCalledWith("Hello mobile room", { files: [] });
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
    } finally {
      localStorage.removeItem("fusion:chat-scope");
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: sets and clears keyboard overlap CSS vars on chat thread", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const thread = document.querySelector(".chat-thread") as HTMLDivElement;
      expect(thread).toBeInTheDocument();
      expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("0px");

      // Focus the chat textarea so the hook treats the active element as a
      // keyboard-focusable target.
      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(mockVV, "height", {
        value: 560,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("284px");
        expect(thread.style.getPropertyValue("--vv-height")).toBe("560px");
      });

      // Blur to signal keyboard dismissal
      await act(async () => {
        textarea.blur();
      });

      Object.defineProperty(mockVV, "height", {
        value: 844,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("284px");
        expect(thread.style.getPropertyValue("--vv-height")).toBe("560px");
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: applies keyboard-active class for iOS fallback when viewport offset is present", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 800,
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const thread = document.querySelector(".chat-thread") as HTMLDivElement;
      expect(thread).toBeInTheDocument();
      expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(false);

      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(mockVV, "height", { value: 784, writable: true, configurable: true });
      Object.defineProperty(mockVV, "offsetTop", { value: 16, writable: true, configurable: true });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("0px");
        expect(thread.style.getPropertyValue("--vv-height")).toBe("784px");
        expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(true);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-5365: mobile keyboard viewport vars follow settled sample and suppress blur-dismiss shrink", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const thread = document.querySelector(".chat-thread") as HTMLDivElement;
      expect(thread).toBeInTheDocument();
      expect(thread.style.getPropertyValue("--vv-height")).toBe("844px");
      expect(thread.style.getPropertyValue("--vv-offset-top")).toBe("0px");
      expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("0px");

      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(mockVV, "offsetTop", { value: 180, writable: true, configurable: true });
      Object.defineProperty(mockVV, "height", { value: 820, writable: true, configurable: true });
      act(() => {
        for (const cb of listeners.resize) cb();
      });
      expect(thread.style.getPropertyValue("--vv-height")).toBe("820px");

      Object.defineProperty(mockVV, "offsetTop", { value: 0, writable: true, configurable: true });
      Object.defineProperty(mockVV, "height", { value: 560, writable: true, configurable: true });
      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.style.getPropertyValue("--vv-height")).toBe("560px");
        expect(thread.style.getPropertyValue("--vv-offset-top")).toBe("0px");
        expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("284px");
        expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(true);
      });

      const styleAfterVvEvents = thread.getAttribute("style") ?? "";
      expect(styleAfterVvEvents).toContain("--vv-height: 560px");
      expect(styleAfterVvEvents).toContain("--vv-offset-top: 0px");
      expect(styleAfterVvEvents).toContain("--keyboard-overlap: 284px");

      await act(async () => {
        textarea.blur();
        document.dispatchEvent(new Event("focusout"));
      });
      await waitFor(() => {
        expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(false);
      });

      Object.defineProperty(mockVV, "height", { value: 700, writable: true, configurable: true });
      act(() => {
        for (const cb of listeners.resize) cb();
      });
      expect(thread.style.getPropertyValue("--vv-height")).toBe("560px");

      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(mockVV, "height", { value: 640, writable: true, configurable: true });
      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.style.getPropertyValue("--vv-height")).toBe("640px");
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: removes keyboard-active class immediately on blur even before visualViewport settles", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 800,
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const thread = document.querySelector(".chat-thread") as HTMLDivElement;
      expect(thread).toBeInTheDocument();

      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(mockVV, "height", { value: 560, writable: true, configurable: true });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(true);
      });

      await act(async () => {
        textarea.blur();
        document.dispatchEvent(new Event("focusout"));
      });

      await waitFor(() => {
        expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(false);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: scrolls messages container to bottom when keyboard opens", async () => {
    _resetInitialViewportHeight();
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 800,
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      expect(messagesContainer).toBeInTheDocument();

      Object.defineProperty(messagesContainer, "scrollHeight", {
        value: 900,
        configurable: true,
      });
      // In jsdom, scrollTop on a non-scrollable div may not reflect writes.
      // Intercept the setter so the assertion can read back the value the effect wrote.
      let capturedScrollTop = 0;
      Object.defineProperty(messagesContainer, "scrollTop", {
        get() { return capturedScrollTop; },
        set(v: number) { capturedScrollTop = v; },
        configurable: true,
      });

      // Focus the chat textarea so the hook treats the active element as a
      // keyboard-focusable target.
      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(window, "innerHeight", {
        value: 560,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(mockVV, "height", {
        value: 560,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(messagesContainer.scrollTop).toBe(900);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: does not force window scroll when keyboard opens", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 800,
    });

    const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      Object.defineProperty(window, "innerHeight", {
        value: 560,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(mockVV, "height", {
        value: 560,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(scrollToSpy).not.toHaveBeenCalled();
      });
    } finally {
      scrollToSpy.mockRestore();
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: does not subscribe to keyboard tracking without active session", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { mockVV } = mockMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 600,
    });

    try {
      setupMockChat({
        activeSession: null,
        sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(mockVV.addEventListener).toHaveBeenCalledTimes(1);
        expect(mockVV.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
        expect(mockVV.addEventListener).not.toHaveBeenCalledWith("scroll", expect.any(Function));
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("desktop mode: renders thread header even without active session (shows empty state)", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        activeSession: null,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Desktop mode: thread header should always be visible (even in empty state)
      expect(document.querySelector(".chat-thread-header")).toBeInTheDocument();
      // Back button should not be visible in desktop mode
      expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
      // Should show empty state
      expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("desktop mode: thread header is visible with active session", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Desktop mode: thread header should always be visible
      expect(document.querySelector(".chat-thread-header")).toBeInTheDocument();
      // Back button should not be visible in desktop mode
      expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("shows jump-to-latest only after scrolling away from bottom and jumps back on click", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1000 });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      scrollTopValue = 600;
      fireEvent.scroll(messagesContainer);
      expect(screen.getByTestId("chat-jump-to-latest")).toBeInTheDocument();

      await userEvent.click(screen.getByTestId("chat-jump-to-latest"));
      expect(scrollTopValue).toBe(1000);
      await waitFor(() => {
        expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("shows jump-to-latest in rooms after scrolling away from bottom and jumps back on click", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    localStorage.setItem("fusion:chat-scope", "rooms");
    try {
      setupMockChat({ activeSession: null, messages: [] });
      setupMockRooms({
        activeRoom: createRoomFixture("general"),
        rooms: [createRoomFixture("general")],
        messages: [
          {
            id: "room-msg-001",
            roomId: "room-general",
            role: "assistant",
            content: "One",
            thinkingOutput: null,
            metadata: null,
            senderAgentId: null,
            mentions: [],
            createdAt: "2026-05-12T00:00:00.000Z",
          },
        ],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1000 });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();

      scrollTopValue = 600;
      fireEvent.scroll(messagesContainer);
      expect(screen.getByTestId("chat-jump-to-latest")).toBeInTheDocument();

      await userEvent.click(screen.getByTestId("chat-jump-to-latest"));
      expect(scrollTopValue).toBe(1000);
      await waitFor(() => {
        expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();
      });
    } finally {
      localStorage.removeItem("fusion:chat-scope");
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-3884: snaps to bottom when opening a session with loaded messages", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 950 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(scrollTopValue).toBe(950);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-3884: re-anchors when messagesLoading transitions to loaded with messages", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({ activeSession: activeSessionFixture, messages: [], messagesLoading: true });
      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 980 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      setupMockChat({
        activeSession: activeSessionFixture,
        messagesLoading: false,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Loaded", createdAt: "2026-04-08T00:00:00.000Z" }],
      });
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(scrollTopValue).toBe(980);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-4040: mobile thread entry anchors to latest message", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1040 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(1040);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-4040: mobile visibility restore re-anchors chat thread to latest", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 250;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1180 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      fireEvent(document, new Event("visibilitychange"));
      scrollTopValue = 300;

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      fireEvent(document, new Event("visibilitychange"));

      // Regression guard: visibility restore must explicitly re-anchor when pinned.
      // Without that, this only passed when leftover anchorToBottom rAF callbacks
      // happened to run after the visibility event.
      expect(scrollTopValue).toBe(1180);
    } finally {
      restoreMatchMedia.mockRestore();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  });

  it("FN-4336: direct chat re-anchors on ResizeObserver growth in mobile", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    const originalResizeObserver = globalThis.ResizeObserver;
    let resizeCallback: ResizeObserverCallback | null = null;

    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 1000;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(1000);
      });

      scrollHeightValue = 1300;
      await act(async () => {
        resizeCallback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(1300);
      });
    } finally {
      restoreMatchMedia.mockRestore();
      if (originalResizeObserver) {
        vi.stubGlobal("ResizeObserver", originalResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("FN-4336: direct chat ResizeObserver growth keeps thread pinned", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    const originalResizeObserver = globalThis.ResizeObserver;
    let resizeCallback: ResizeObserverCallback | null = null;

    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 2000;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      fireEvent.scroll(messagesContainer);
      scrollHeightValue = 2400;

      await act(async () => {
        resizeCallback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(2400);
      });
    } finally {
      restoreMatchMedia.mockRestore();
      if (originalResizeObserver) {
        vi.stubGlobal("ResizeObserver", originalResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("FN-4336: visibility restore performs deferred direct chat settle pass", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    vi.useFakeTimers();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 1000;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      fireEvent(document, new Event("visibilitychange"));
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      scrollHeightValue = 1500;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(260);
        await vi.runOnlyPendingTimersAsync();
      });

      expect(scrollTopValue).toBe(1500);
    } finally {
      restoreMatchMedia.mockRestore();
      vi.useRealTimers();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  });

  it("FN-4336: rooms scope does not attach direct ResizeObserver follower", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    const originalResizeObserver = globalThis.ResizeObserver;
    localStorage.setItem("fusion:chat-scope", "rooms");
    const resizeObserverCtor = vi.fn();

    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCtor(callback);
        }
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );

    try {
      setupMockChat({ activeSession: null, messages: [] });
      setupMockRooms({
        activeRoom: createRoomFixture("general"),
        rooms: [createRoomFixture("general")],
        messages: [
          {
            id: "room-msg-001",
            roomId: "room-general",
            role: "assistant",
            content: "Room message",
            thinkingOutput: null,
            metadata: null,
            senderAgentId: null,
            mentions: [],
            createdAt: "2026-05-12T00:00:00.000Z",
          },
        ],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      await waitFor(() => {
        expect(screen.getByTestId("chat-sidebar-rooms")).toBeInTheDocument();
      });
      expect(resizeObserverCtor).not.toHaveBeenCalled();
    } finally {
      restoreMatchMedia.mockRestore();
      if (originalResizeObserver) {
        vi.stubGlobal("ResizeObserver", originalResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("FN-4336: desktop direct chat still re-anchors on ResizeObserver growth", async () => {
    const restoreMatchMedia = mockViewportMode("desktop");
    const originalResizeObserver = globalThis.ResizeObserver;
    let resizeCallback: ResizeObserverCallback | null = null;

    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 1200;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 300 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(1200);
      });

      scrollHeightValue = 1700;
      await act(async () => {
        resizeCallback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(1700);
      });
    } finally {
      restoreMatchMedia.mockRestore();
      if (originalResizeObserver) {
        vi.stubGlobal("ResizeObserver", originalResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("FN-5380: desktop visibility restore preserves manual direct-thread scroll", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 600;
      let scrollHeightValue = 1200;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      fireEvent.scroll(messagesContainer);
      expect(screen.getByTestId("chat-jump-to-latest")).toBeInTheDocument();

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      fireEvent(document, new Event("visibilitychange"));

      await waitFor(() => {
        expect(scrollTopValue).toBe(600);
      });
      expect(screen.getByTestId("chat-jump-to-latest")).toBeInTheDocument();

      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" },
          { id: "msg-002", sessionId: "session-001", role: "assistant", content: "Two", createdAt: "2026-04-08T00:00:10.000Z" },
        ],
      });
      scrollTopValue = 700;
      scrollHeightValue = 1300;
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(scrollTopValue).toBe(1300);
      });
    } finally {
      restoreMatchMedia.mockRestore();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  });

  it("FN-5380: desktop pageshow preserves direct chat scroll position", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 420;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1280 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      fireEvent(window, new Event("pageshow"));

      await waitFor(() => {
        expect(scrollTopValue).toBe(420);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-3884: retries bottom anchor while container height keeps growing", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    const originalRaf = window.requestAnimationFrame;
    const rafQueue: FrameRequestCallback[] = [];
    window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 600;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      scrollHeightValue = 900;
      await act(async () => {
        while (rafQueue.length > 0) {
          const cb = rafQueue.shift();
          cb?.(performance.now());
        }
      });

      expect(scrollTopValue).toBe(900);
    } finally {
      window.requestAnimationFrame = originalRaf;
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-3884: snaps to bottom when switching active session id", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });
      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 900;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      setupMockChat({
        activeSession: { ...activeSessionFixture, id: "session-002" },
        messages: [{ id: "msg-101", sessionId: "session-002", role: "assistant", content: "Two", createdAt: "2026-04-08T00:01:00.000Z" }],
      });
      scrollHeightValue = 1300;
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(scrollTopValue).toBe(1300);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-3884: does not yank when user scrolled up on same-session updates", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 700;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1200 });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      fireEvent.scroll(messagesContainer);

      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [
          { id: "msg-000", sessionId: "session-001", role: "assistant", content: "Older", createdAt: "2026-04-07T23:59:00.000Z" },
          { id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
      });
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(scrollTopValue).toBe(700);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });
});

describe("ChatView mobile CSS contract", () => {
  const css = loadAllAppCss();

  // Helper to find a selector rule within any mobile media query block
  function findMobileRule(selector: string): string | null {
    const mobileRegex = /@media[^{]*\(max-width:\s*768px\)[^{]*\{([\s\S]*?)\n\}/g;
    let match;
    while ((match = mobileRegex.exec(css)) !== null) {
      const mediaContent = match[1];
      if (mediaContent.includes(selector)) {
        const ruleMatch = mediaContent.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
        if (ruleMatch) return ruleMatch[1];
      }
    }
    return null;
  }

  // Helper to check if any mobile media query contains a selector with a specific property
  function mobileRuleContains(selector: string, property: string): boolean {
    const ruleCSS = findMobileRule(selector);
    return ruleCSS !== null && ruleCSS.includes(property);
  }

  // Helper to check if a selector does NOT contain a property in any mobile media query
  function mobileRuleNotContains(selector: string, property: string): boolean {
    const mobileRegex = /@media[^{]*\(max-width:\s*768px\)[^{]*\{([\s\S]*?)\n\}/g;
    let match;
    while ((match = mobileRegex.exec(css)) !== null) {
      const mediaContent = match[1];
      if (mediaContent.includes(selector)) {
        const ruleMatch = mediaContent.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
        if (ruleMatch && ruleMatch[1].includes(property)) {
          return false;
        }
      }
    }
    return true;
  }

  it("mobile .chat-sidebar uses height: 100% instead of max-height: 40vh", async () => {
    expect(mobileRuleContains(".chat-sidebar", "height: 100%")).toBe(true);
    expect(mobileRuleNotContains(".chat-sidebar", "max-height: 40vh")).toBe(true);
  });

  it("mobile .chat-sidebar-header is hidden", async () => {
    expect(mobileRuleContains(".chat-sidebar-header", "display: none")).toBe(true);
  });

  it("mobile .chat-sidebar-search remains visible (FN-4120)", async () => {
    expect(mobileRuleNotContains(".chat-sidebar-search", "display: none")).toBe(true);
  });

  it("mobile .chat-sidebar-search keeps a token-based touch target (FN-4120)", async () => {
    expect(mobileRuleContains(".chat-sidebar-search", "min-height: calc(var(--space-2xl) + var(--space-xs))")).toBe(true);
  });

  it("mobile .chat-sidebar-list has flex: 1 and overflow-y: auto for scrolling", async () => {
    expect(mobileRuleContains(".chat-sidebar-list", "flex: 1")).toBe(true);
    expect(mobileRuleContains(".chat-sidebar-list", "overflow-y: auto")).toBe(true);
    expect(mobileRuleContains(".chat-sidebar-list", "min-height: 0")).toBe(true);
  });

  it("mobile .chat-sidebar-footer exists with display block and border-top", async () => {
    expect(mobileRuleContains(".chat-sidebar-footer", "display: block")).toBe(true);
    expect(mobileRuleContains(".chat-sidebar-footer", "border-top")).toBe(true);
  });

  it("mobile .chat-sidebar-footer-btn stays full-width and centered", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-sidebar-footer\s+\.chat-sidebar-footer-btn\s*\{[^}]*width:\s*100%[^}]*justify-content:\s*center/);
  });

  it("mobile does not override assistant render toggle visibility", async () => {
    expect(mobileRuleNotContains(".chat-message-render-toggle", "display: inline-flex")).toBe(true);
  });

  it("mobile keeps ChatView dialog backdrop centered with safe-area padding", async () => {
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "align-items: center")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "justify-content: center")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "overflow-y: auto")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "padding-top: max(var(--space-md), env(safe-area-inset-top, 0px))")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "padding-bottom: max(var(--space-md), env(safe-area-inset-bottom, 0px))")).toBe(true);
  });

  it("mobile constrains ChatView dialog height and allows internal scrolling", async () => {
    expect(mobileRuleContains(".chat-view-dialog", "max-height: calc(100dvh - (var(--space-md) * 2) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog", "display: flex")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog", "flex-direction: column")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog", "overflow-y: auto")).toBe(true);
  });

  it("mobile ChatView dialog rules do not set full-screen heights", async () => {
    expect(mobileRuleNotContains(".chat-view-dialog", "height: 100vh")).toBe(true);
    expect(mobileRuleNotContains(".chat-view-dialog", "height: 100dvh")).toBe(true);
  });

  it("mobile includes keyboard-aware chat-thread height rule", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread--keyboard-active\s*\{[^}]*--vv-height/);
  });

  it("mobile widens chat bubbles for readability", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message\s*\{[^}]*max-width:\s*90%/);
  });

  it("mobile keeps thread-header identity and render toggle inline", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread-header\s*\{[^}]*flex-wrap:\s*nowrap/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread-header-identity\s*\{[^}]*flex:\s*1\s+1\s+auto[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread-header-render-toggle\s*\{[^}]*flex-shrink:\s*0/);
  });

  it("FN-4352: response copy action stays compact on mobile", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message-copy-action\s*\{[^}]*opacity:\s*1/);
    expect(css).not.toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message-copy-action\s*\{[^}]*min-width:\s*calc\(var\(--space-lg\)\s*\*\s*2\.25\)/);
    expect(css).not.toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message-copy-action\s*\{[^}]*min-height:\s*calc\(var\(--space-lg\)\s*\*\s*2\.25\)/);
  });
});

describe("ChatView empty-state token guards", () => {
  it("renders loading and empty states with chat-empty-state class and no inline text-secondary style", async () => {
    setupMockChat({
      sessions: [],
      filteredSessions: [],
      sessionsLoading: true,
      activeSession: activeSessionFixture,
      messages: [],
      messagesLoading: true,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const loadingNodes = screen.getAllByText("Loading messages...");
    const sidebarLoadingNode = screen.getByText("Loading...");

    const legacyToken = `--text-${"secondary"}`;
    expect(sidebarLoadingNode.className).toContain("chat-empty-state");
    expect(sidebarLoadingNode.getAttribute("style") ?? "").not.toContain(legacyToken);

    for (const node of loadingNodes) {
      expect(node.className).toContain("chat-empty-state");
      expect(node.getAttribute("style") ?? "").not.toContain(legacyToken);
    }
  });

  it("keeps ChatView source files free of deprecated secondary token", async () => {
    const chatViewTsx = readFileSync("app/components/ChatView.tsx", "utf8");
    const chatViewCss = readFileSync("app/components/ChatView.css", "utf8");
    const legacyToken = `--text-${"secondary"}`;

    expect(chatViewTsx.includes(legacyToken)).toBe(false);
    expect(chatViewCss.includes(legacyToken)).toBe(false);
  });
});

/**
 * Tests for ChatView component: sidebar, session list, message thread,
 * new chat dialog, and input handling.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import type { DiscoveredSkill } from "@fusion/dashboard";
import { loadAllAppCss } from "../../test/cssFixture";

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();
import * as useChatModule from "../../hooks/useChat";
import type { UseChatReturn, ChatSessionInfo, ChatMessageInfo, ToolCallInfo } from "../../hooks/useChat";
import * as apiModule from "../../api";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";

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

// Mock fetchAgents for new chat dialog
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
  }),
  fetchAgents: vi.fn().mockResolvedValue([
    { id: "agent-001", name: "Alpha", role: "executor", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
    { id: "agent-002", name: "Beta", role: "reviewer", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
  ]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
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
    matches: isMobile && query === "(max-width: 768px)",
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

  it("renders empty state when no session is selected", () => {
    setupMockChat({ sessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    expect(screen.getByTestId("chat-new-btn")).toBeInTheDocument();
  });

  it("renders session list in sidebar", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByText("Test Chat"));

    expect(selectSession).toHaveBeenCalledWith("session-001");
  });

  it("highlights active session", () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    expect(sessionItem).toHaveClass("chat-session-item--active");
  });

  it("opens new chat dialog when clicking New Chat button", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

  it("creates session with model selection (model mode uses KB agent ID)", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "__fn_agent__" });
    setupMockChat({ sessions: [], filteredSessions: [], createSession });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;

    // Switch to model mode
    await userEvent.click(within(dialog!).getByTestId("chat-new-dialog-mode-model"));

    // Select a model from the dropdown (now visible in model mode)
    const modelDropdown = within(dialog!).getByTestId("mock-model-dropdown");
    await userEvent.selectOptions(modelDropdown, "anthropic/claude-sonnet-4-5");

    await userEvent.click(within(dialog!).getByText("Create"));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        agentId: "__fn_agent__",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
    });
  });

  it("creates session without model selection omits model fields (agent mode)", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "agent-001" });
    setupMockChat({ sessions: [], filteredSessions: [], createSession });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

  it("renders messages for active session", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi there!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
  });

  it("does not render markdown/plain toggle controls in the thread header", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

  it("renders tool calls from persisted messages", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("read")).toBeInTheDocument();
    const preview = document.querySelector(".chat-tool-call-preview") as HTMLElement | null;
    expect(preview).toHaveTextContent("result: contents");
  });

  it("renders streaming tool calls", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const streamingBubble = document.querySelector(".chat-message--streaming") as HTMLElement | null;
    expect(streamingBubble).toBeInTheDocument();
    expect(within(streamingBubble as HTMLElement).getByText("read")).toBeInTheDocument();
    const preview = (streamingBubble as HTMLElement).querySelector(".chat-tool-call-preview");
    expect(preview).toHaveTextContent("path=foo.ts");
  });

  it("collapses multiple tool calls into single summary line", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const group = screen.getByTestId("chat-tool-calls-group") as HTMLDetailsElement;
    expect(group).toBeInTheDocument();
    expect(group.open).toBe(false);

    const summary = group.querySelector(".chat-tool-calls-group-summary") as HTMLElement;
    expect(summary).toBeInTheDocument();
    expect(summary.querySelector(".chat-tool-calls-count")).toHaveTextContent("2 tool calls");
    expect(summary.querySelector(".chat-tool-calls-names")).toHaveTextContent("read, grep");
  });

  it("auto-opens grouped tool calls when any tool call is running", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const group = screen.getByTestId("chat-tool-calls-group") as HTMLDetailsElement;
    expect(group).toBeInTheDocument();
    expect(group.open).toBe(true);
  });

  it("shows status counts in group summary", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("(1 running)")).toBeInTheDocument();
  });

  it("shows error count when there are errors and no running calls", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const group = screen.getByTestId("chat-tool-calls-group") as HTMLDetailsElement;
    expect(group.open).toBe(false);

    const summary = group.querySelector(".chat-tool-calls-group-summary") as HTMLElement;
    await userEvent.click(summary);

    expect(group.open).toBe(true);
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("grep")).toBeInTheDocument();
  });

  it("single tool call renders without group wrapper", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-tool-calls-group")).not.toBeInTheDocument();
    const details = document.querySelector(".chat-tool-call") as HTMLDetailsElement | null;
    expect(details).toBeInTheDocument();
    expect(details?.open).toBe(false);
    expect(details?.querySelector(".chat-tool-call-name")).toHaveTextContent("read");
    expect(details?.querySelector(".chat-tool-call-status-text")).toHaveTextContent("completed");
  });

  it("truncates tool names when more than 5 unique", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("read, edit, bash, grep, write, +1 more")).toBeInTheDocument();
  });

  it("running tool calls show running indicator", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(document.querySelector(".chat-tool-call--running")).toBeInTheDocument();
  });

  it("error tool calls show error styling", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(document.querySelector(".chat-tool-call--error")).toBeInTheDocument();
  });

  it("shows resolved agent name in assistant message avatar", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Agent Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello from Alpha", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const avatar = document.querySelector(".chat-message-avatar") as HTMLElement | null;
    expect(avatar).toBeInTheDocument();

    await waitFor(() => {
      expect(within(avatar!).getByText("Alpha")).toBeInTheDocument();
    });
    expect(within(avatar!).queryByText("Fusion")).not.toBeInTheDocument();
  });

  it("hides per-message assistant identity for fn agent (model-only) sessions", () => {
    // Model-only chats use the active model as their identity, which is
    // already shown in the thread header. We deliberately suppress the
    // per-message avatar to avoid repeating it on every reply.
    setupMockChat({
      activeSession: { id: "session-001", agentId: "__fn_agent__", status: "active", title: "Fusion Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Built-in assistant response", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-001");
    expect(messageBubble.querySelector(".chat-message-avatar")).toBeNull();
    // The model name still appears once in the thread header.
    await waitFor(() => {
      expect(screen.getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    });
  });

  it("shows copy actions only for assistant responses in provider/model chats", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-run-failure");
    await userEvent.click(within(messageBubble).getByText("Failure details"));
    await userEvent.click(within(messageBubble).getByText("View failure details"));

    expect(within(messageBubble).getAllByText("Agent run 42")).toHaveLength(2);
    expect(within(messageBubble).getByText("Kind")).toBeInTheDocument();
    expect(within(messageBubble).getByText("agent-run")).toBeInTheDocument();
    expect(within(messageBubble).getByText("ID")).toBeInTheDocument();
    expect(within(messageBubble).getByText("run-42")).toBeInTheDocument();
  });

  it("shows streaming copy action for provider chats", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-copy-response-streaming")).toBeInTheDocument();
  });

  it("does not show copy actions for non-provider sessions", () => {
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [
        { id: "msg-assistant", sessionId: "session-001", role: "assistant", content: "Answer", createdAt: "2026-04-08T00:00:01.000Z" },
      ],
      isStreaming: true,
      streamingText: "Live answer",
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "Hello world{enter}");

    expect(sendMessage).toHaveBeenCalledWith("Hello world", []);
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "Room hello{enter}");

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("Room hello");
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "Room click hello");
    await userEvent.click(screen.getByTestId("chat-send-btn"));

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("Room click hello");
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
    localStorage.removeItem("fusion:chat-scope");
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "Hello world{Shift>}{Enter}{/Shift}");

    expect(sendMessage).not.toHaveBeenCalled();
  });

  describe("attachments", () => {
    it("clicking paperclip triggers hidden file input", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, "click");

      await userEvent.click(screen.getByTestId("chat-attach-btn"));
      expect(clickSpy).toHaveBeenCalled();
    });

    it("allows attaching an image and sends with attachments only", async () => {
      const sendMessage = vi.fn();
      setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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
      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const textFile = new File(["hello"], "note.txt", { type: "text/plain" });
      fireEvent.change(fileInput, { target: { files: [textFile] } });

      expect(await screen.findByText("note.txt")).toBeInTheDocument();
      expect(mockCreateObjectURL).not.toHaveBeenCalled();
    });

    it("adds image attachments from paste events", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      const imageFile = new File(["image"], "paste.png", { type: "image/png" });
      fireEvent.paste(textarea, { clipboardData: { files: [imageFile] } });

      expect(await screen.findByTestId("chat-attachment-previews")).toBeInTheDocument();
    });

    it("adds attachments from drag-and-drop", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const wrapper = document.querySelector(".chat-input-wrapper") as HTMLElement;
      const textFile = new File(["log"], "drop.log", { type: "text/x-log" });
      fireEvent.drop(wrapper, { dataTransfer: { files: [textFile] } });

      expect(await screen.findByText("drop.log")).toBeInTheDocument();
    });

    it("removes pending attachments and revokes preview urls", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const imageFile = new File(["image"], "shot.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [imageFile] } });

      const removeButton = await screen.findByTestId("chat-attachment-remove-0");
      await userEvent.click(removeButton);

      expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:shot.png");
      expect(screen.queryByTestId("chat-attachment-previews")).not.toBeInTheDocument();
    });

    it("renders message attachments inline as actionable links", () => {
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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "@");

      expect(await screen.findByTestId("agent-mention-popup")).toBeInTheDocument();
    });

    it("filters mention popup by text after @", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "@be");

      expect(await screen.findByTestId("agent-mention-item-agent-002")).toBeInTheDocument();
      expect(screen.queryByTestId("agent-mention-item-agent-001")).not.toBeInTheDocument();
    });

    it("hides mention popup on Escape", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "@");
      expect(await screen.findByTestId("agent-mention-popup")).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("agent-mention-popup")).not.toBeInTheDocument();
    });

    it("inserts mention text when selecting an agent", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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
            content: "Ping @Beta",
            senderAgentId: "agent-001",
            metadata: null,
            attachments: [],
            mentions: ["agent-002"],
            createdAt: "2026-04-08T00:00:00.000Z",
          },
        ],
      });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "@");

      expect(await screen.findByTestId("agent-mention-members-header")).toBeInTheDocument();
      expect(screen.queryByTestId("agent-mention-others-header")).not.toBeInTheDocument();

      const nonMemberChip = screen.getByText("@Beta", { selector: ".chat-mention-chip--non-member" });
      expect(nonMemberChip).toHaveAttribute("title", "Not a member of engineering");
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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");
      await screen.findByRole("option", { name: /alpha/i });

      // Wrap to bottom from the first item.
      await userEvent.keyboard("{ArrowUp}");
      expect(screen.getByRole("option", { name: /gamma/i })).toHaveClass(
        "chat-skill-menu-item--highlighted",
      );

      await userEvent.keyboard("{Enter}");
      expect(textarea).toHaveValue("/skill:gamma ");
    });

    it("supports selecting highlighted skill with Tab", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-alpha", name: "alpha", relativePath: "skills/alpha.md" }),
        createMockSkill({ id: "skill-beta", name: "beta", relativePath: "skills/beta.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");

      expect(await screen.findByText("No skills available")).toBeInTheDocument();
    });
  });

  it("disables send button when input is empty", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sendButton = screen.getByTestId("chat-send-btn");
    expect(sendButton).toBeDisabled();
  });

  it("renders stop button when streaming", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: true,
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-stop-btn"));
    expect(stopStreaming).toHaveBeenCalledTimes(1);
  });

  it("renders send button when not streaming", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: false,
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-pending-indicator")).toHaveTextContent("Queued: Queued while streaming");

    await userEvent.click(screen.getByTestId("chat-pending-dismiss"));
    expect(clearPendingMessage).toHaveBeenCalledTimes(1);
  });

  it("textarea is enabled during streaming", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
      isStreaming: true,
      streamingText: "Thinking...",
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");

    // User should be able to type in the textarea while streaming
    fireEvent.change(textarea, { target: { value: "Second message" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Second message");
  });

  it("shows streaming indicator when isStreaming is true", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
      isStreaming: true,
      streamingText: "Typing...",
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    // Streaming message should show
    const streamingMessage = document.querySelector(".chat-message--streaming") as HTMLElement | null;
    expect(streamingMessage).toBeInTheDocument();
    expect(streamingMessage?.textContent).toContain("Typing");
  });

  it("shows thinking blocks collapsed by default", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Here's my response", thinkingOutput: "I need to think about this...", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const message = screen.getByTestId("chat-message-msg-001");
    const details = message.querySelector("details");
    expect(details).toBeInTheDocument();
    expect(details).toHaveProperty("open", false);
  });

  describe("streaming states", () => {
    it("keeps mobile thread visible when active session metadata refreshes during streaming", () => {
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

      const { rerender } = render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(document.querySelector(".chat-message--streaming")?.textContent).toContain("Connecting");
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(document.querySelector(".chat-message--streaming")?.textContent).toContain("Connecting");
      expect(screen.queryByText("Start a new conversation")).not.toBeInTheDocument();
      expect(screen.queryByText("No messages yet. Start the conversation!")).not.toBeInTheDocument();
      expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();

      void mediaQuerySpy;
    });

    it("keeps the streaming indicator visible while message history is still loading", () => {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [],
        messagesLoading: true,
        isStreaming: true,
        streamingText: "",
        streamingThinking: "",
      });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const streamingMessage = document.querySelector(".chat-message--streaming") as HTMLElement | null;
      expect(streamingMessage).toBeInTheDocument();
      expect(streamingMessage?.textContent).toContain("Connecting");
      expect(screen.queryByText("Loading messages...")).not.toBeInTheDocument();
    });

    it("shows waiting indicator when streaming starts before text arrives", () => {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "",
      });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Streaming message should show with "Connecting..." text
      const streamingMessage = document.querySelector(".chat-message--streaming") as HTMLElement | null;
      expect(streamingMessage).toBeInTheDocument();
      expect(streamingMessage?.textContent).toContain("Connecting");

      // Waiting class should be present
      const waitingContent = streamingMessage?.querySelector(".chat-message-content--waiting");
      expect(waitingContent).toBeInTheDocument();

      // Typing indicator dots should be rendered
      const typingIndicator = streamingMessage?.querySelector(".chat-typing-indicator");
      expect(typingIndicator).toBeInTheDocument();
      expect(typingIndicator?.querySelectorAll("span").length).toBe(3);
    });

    it("shows thinking indicator when streaming thinking arrives before text", () => {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "analyzing the request...",
      });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Frontend work")).toBeInTheDocument();
    expect(screen.queryByText("Backend API")).not.toBeInTheDocument();
  });

  it("shows empty state with Start Chat button (no inline agent selector)", () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    // Find the New Chat button in the empty state section
    const emptyState = document.querySelector(".chat-empty-state") as HTMLElement | null;
    expect(within(emptyState!).getByRole("button", { name: /new chat/i })).toBeInTheDocument();
    // Should NOT have an agent selector in empty state
    expect(emptyState?.querySelector("select")).toBeNull();
  });

  it("shows context menu on right-click", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    await userEvent.pointer({ target: sessionItem, keys: "[MouseRight]" });

    await userEvent.click(screen.getByTestId("chat-context-delete"));

    // Dialog should be open
    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    expect(dialog).toBeInTheDocument();
    expect(within(dialog!).getByText("Delete Conversation?")).toBeInTheDocument();
  });

  it("shows formatted model label for fn agent sessions in sidebar", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    expect(within(sessionItem).getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    expect(within(sessionItem).queryByText("Fusion")).not.toBeInTheDocument();
  });

  it("shows Fusion fallback for fn agent sessions in sidebar without model info", () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "__fn_agent__", status: "active", title: "My Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "__fn_agent__", status: "active", title: "My Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    expect(within(sessionItem).getByText("Fusion")).toBeInTheDocument();
  });

  it("shows agent ID for non-fn agent sessions in sidebar", () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "my-custom-agent", status: "active", title: "Custom Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "my-custom-agent", status: "active", title: "Custom Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    // Should show the agent ID (truncated to 30 chars)
    expect(within(sessionItem).getByText("my-custom-agent")).toBeInTheDocument();
  });

  it("shows formatted model name in thread header title for fn agent sessions", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const title = document.querySelector(".chat-thread-header-title") as HTMLElement | null;
    expect(title).toBeInTheDocument();
    expect(title).toHaveTextContent("Claude Sonnet 4.5");
    expect(title).not.toHaveTextContent("Fusion");
  });

  it("shows model tag in thread header when non-fn session has model", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const headerModelTag = document.querySelector(".chat-thread-header .chat-model-tag") as HTMLElement | null;
    expect(headerModelTag).toBeInTheDocument();
    expect(headerModelTag?.textContent).toContain("Claude");
  });

  it("does not show duplicate model tag in thread header for fn agent sessions", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const title = document.querySelector(".chat-thread-header-title") as HTMLElement | null;
    expect(title).toHaveTextContent("Claude Sonnet 4.5");

    const headerModelTag = document.querySelector(".chat-thread-header .chat-model-tag") as HTMLElement | null;
    expect(headerModelTag).toBeNull();
  });

  it("keeps provider identity text grouped in header while render toggle stays on the same row", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

  it("does not show model tag when session has no model", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag).not.toBeInTheDocument();
  });

  it("does not repeat the model tag in per-message avatars for non-fn sessions", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-001");
    const avatar = messageBubble.querySelector(".chat-message-avatar") as HTMLElement | null;
    expect(avatar).toBeInTheDocument();
    expect(avatar?.querySelector(".chat-model-tag")).toBeNull();
  });

  it("hides per-message identity entirely for fn agent (model-only) sessions even when model is set", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-001");
    expect(messageBubble.querySelector(".chat-message-avatar")).toBeNull();
  });
});

describe("formatModelTag helper function", () => {
  // Import the function for testing - we'll test it via the UI behavior instead
  // The function is not exported, so we test it indirectly through the component

  it("formats claude-sonnet-4-5 model ID correctly", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag?.textContent).toContain("Claude Sonnet");
  });

  it("formats gpt-4o model ID correctly", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag?.textContent).toContain("GPT-4o");
  });

  it("formats gemini-2.5-pro model ID correctly", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag?.textContent).toContain("Gemini");
  });

  it("returns null when modelId is missing", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag).not.toBeInTheDocument();
  });

  it("returns null when provider is missing", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag).not.toBeInTheDocument();
  });
});

describe("Chat Session Delete Button", () => {
  it("renders delete button on each session item", () => {
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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const deleteButtons = screen.getAllByTestId("chat-session-delete-btn");
    expect(deleteButtons.length).toBe(2);
  });

  it("clicking delete button shows confirmation dialog", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const deleteButton = screen.getByTestId("chat-session-delete-btn");
    await userEvent.click(deleteButton);

    expect(selectSession).not.toHaveBeenCalled();
  });

  it("confirming delete calls deleteSession", async () => {
    const deleteSession = vi.fn();
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      deleteSession,
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

  it("uses shared error surface tokens for failure bubbles and detail affordances", () => {
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

describe("FN-3911 chat session list layout", () => {
  const css = loadAllAppCss();

  it("reserves right padding on title and preview rows so text clears the delete button", () => {
    const titleMatch = css.match(/\.chat-session-title\s*\{([^}]*)\}/);
    const previewMatch = css.match(/\.chat-session-preview\s*\{([^}]*)\}/);
    expect(titleMatch).toBeTruthy();
    expect(previewMatch).toBeTruthy();
    expect(titleMatch?.[1]).toMatch(/padding-right:\s*calc\(var\(--space-md\)\s*\*\s*3\)/);
    expect(previewMatch?.[1]).toMatch(/padding-right:\s*calc\(var\(--space-md\)\s*\*\s*3\)/);
  });

  it("applies a mobile padding override that still clears the larger delete button", () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-session-title,\s*\.chat-session-preview\s*\{\s*padding-right:\s*calc\(\(var\(--space-lg\)\s*\*\s*2\.25\)\s*\+\s*var\(--space-sm\)\);\s*\}/,
    );
  });
});

describe("Chat Session Delete Button CSS", () => {
  const css = loadAllAppCss();

  it(".chat-session-delete-btn exists with opacity: 0", () => {
    const match = css.match(/\.chat-session-delete-btn\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("opacity: 0");
  });

  it(".chat-session-item:hover .chat-session-delete-btn has opacity: 1", () => {
    const match = css.match(/\.chat-session-item:hover\s*\.chat-session-delete-btn\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("opacity: 1");
  });

  it("mobile override makes delete button always visible", () => {
    // Find all mobile media query blocks and check if any has chat-session-delete-btn with opacity: 1
    const mobileRegex = /@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/g;
    let match;
    let foundMobileDeleteBtn = false;
    while ((match = mobileRegex.exec(css)) !== null) {
      const mediaContent = match[1];
      if (mediaContent.includes(".chat-session-delete-btn")) {
        const deleteBtnMatch = mediaContent.match(/\.chat-session-delete-btn\s*\{([^}]*)\}/);
        if (deleteBtnMatch && deleteBtnMatch[1].includes("opacity: 1")) {
          foundMobileDeleteBtn = true;
          break;
        }
      }
    }
    expect(foundMobileDeleteBtn).toBe(true);
  });
});

describe("ChatView CSS — mobile thread switcher", () => {
  const css = loadAllAppCss();

  it("includes mobile session switcher trigger and dropdown tokenized contracts", () => {
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

  it("keeps mobile override for header identity overflow visible so dropdown can render", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread-header-identity\s*\{[^}]*overflow:\s*visible;/);
  });
});

describe("ChatView CSS — nested flexbox scrolling fix", () => {
  const css = loadAllAppCss();

  it(".chat-session-list has min-height: 0 for proper vertical scrolling", () => {
    const match = css.match(/\.chat-session-list\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("min-height: 0");
  });

  it(".chat-thread has min-height: 0 for proper vertical scrolling", () => {
    const match = css.match(/\.chat-thread\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("min-height: 0");
  });

  it(".chat-messages has min-height: 0 for proper vertical scrolling", () => {
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

    render(<ChatView projectId="proj-456" addToast={vi.fn()} />);

    await waitFor(() => {
      expect(apiModule.fetchAgents).toHaveBeenCalledWith(undefined, "proj-456");
    });
  });

  it("passes projectId to NewChatDialog for agent selection", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-789" addToast={vi.fn()} />);

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
    const { rerender } = render(<ChatView projectId="proj-001" addToast={vi.fn()} />);

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

    const { rerender } = render(<ChatView projectId="proj-001" addToast={vi.fn()} />);

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
  it("renders sidebar sections without an empty header spacer", () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(document.querySelector(".chat-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".chat-sidebar-search")).toBeInTheDocument();
    expect(document.querySelector(".chat-sidebar-list")).toBeInTheDocument();
    expect(document.querySelector(".chat-sidebar-footer")).toBeInTheDocument();
    expect(document.querySelector(".chat-sidebar-header")).not.toBeInTheDocument();
  });

  it("renders desktop header New Chat button", () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-new-btn")).toBeInTheDocument();
  });

  it("renders mobile footer New Chat button", () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-new-btn")).toBeInTheDocument();
  });

  it("opens new chat dialog when clicking mobile footer New Chat button", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    expect(dialog).toBeInTheDocument();
  });

  it("session list has both chat-session-list and chat-sidebar-list classes", () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionList = document.querySelector(".chat-session-list") as HTMLElement | null;
    expect(sessionList).toBeInTheDocument();
    expect(sessionList).toHaveClass("chat-sidebar-list");
  });
});

describe("room creation", () => {
  it("opens the newly created room and collapses the mobile sidebar on success", async () => {
    const viewportSpy = mockViewportMode("mobile");
    const { createRoom } = setupStatefulCreateRoomMock();
    setupMockChat({ sessions: [], filteredSessions: [] });
    localStorage.setItem("fusion:chat-scope", "rooms");

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-create-room-btn"));
    const dialog = await screen.findByRole("dialog", { name: "Create room" });
    await userEvent.type(within(dialog).getByLabelText("Room name"), "newroom");
    await userEvent.click(within(screen.getByTestId("create-room-member-list")).getByText("Alpha"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create room" }));

    await waitFor(() => {
      expect(createRoom).toHaveBeenCalledWith({ name: "newroom", memberAgentIds: ["agent-001"] });
    });
    await waitFor(() => {
      expect(document.querySelector(".chat-sidebar")).toHaveClass("chat-sidebar--hidden");
    });
    expect(screen.queryByRole("dialog", { name: "Create room" })).toBeNull();
    expect(within(document.querySelector(".chat-room-thread-header") as HTMLElement).getByText("#newroom")).toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("opens the newly created room on desktop without hiding the sidebar", async () => {
    const viewportSpy = mockViewportMode("desktop");
    const { createRoom } = setupStatefulCreateRoomMock();
    setupMockChat({ sessions: [], filteredSessions: [] });
    localStorage.setItem("fusion:chat-scope", "rooms");

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-create-room-btn"));
    const dialog = await screen.findByRole("dialog", { name: "Create room" });
    await userEvent.type(within(dialog).getByLabelText("Room name"), "newroom");
    await userEvent.click(within(screen.getByTestId("create-room-member-list")).getByText("Alpha"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create room" }));

    await waitFor(() => {
      expect(createRoom).toHaveBeenCalledWith({ name: "newroom", memberAgentIds: ["agent-001"] });
    });
    expect(document.querySelector(".chat-sidebar")).not.toHaveClass("chat-sidebar--hidden");
    expect(screen.queryByRole("dialog", { name: "Create room" })).toBeNull();
    expect(within(document.querySelector(".chat-room-thread-header") as HTMLElement).getByText("#newroom")).toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("keeps the modal open and sidebar visible when room creation fails", async () => {
    const viewportSpy = mockViewportMode("mobile");
    const { createRoom } = setupStatefulCreateRoomMock({ createRejects: true });
    setupMockChat({ sessions: [], filteredSessions: [] });
    localStorage.setItem("fusion:chat-scope", "rooms");

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-create-room-btn"));
    const dialog = await screen.findByRole("dialog", { name: "Create room" });
    await userEvent.type(within(dialog).getByLabelText("Room name"), "newroom");
    await userEvent.click(within(screen.getByTestId("create-room-member-list")).getByText("Alpha"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create room" }));

    await waitFor(() => {
      expect(createRoom).toHaveBeenCalledWith({ name: "newroom", memberAgentIds: ["agent-001"] });
    });
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

  it("hides rooms UI when chatRooms experimental flag is off", () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{}} />);

    expect(screen.queryByTestId("chat-sidebar-scope-rooms")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-sidebar-rooms")).not.toBeInTheDocument();
  });

  it("defaults to Direct with sidebar list visible", () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.getByTestId("chat-sidebar-scope-direct")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("chat-sidebar-scope-rooms")).toHaveAttribute("aria-selected", "false");
    expect(document.querySelector(".chat-session-list")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-sidebar-rooms-empty")).toBeNull();
  });

  it("shows rooms UI when chatRooms experimental flag is on", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.getByTestId("chat-sidebar-scope-rooms")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    expect(screen.getByTestId("chat-sidebar-rooms")).toBeInTheDocument();
  });

  it("shows rooms placeholder and hides direct search/list in Rooms scope", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

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

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-direct"));

    expect(screen.getByTestId("chat-search-input")).toBeInTheDocument();
    expect(document.querySelector(".chat-session-list")).toBeInTheDocument();
    expect(screen.getByTestId("chat-session-session-001")).toHaveClass("chat-session-item--active");
  });

  it("forces direct scope when localStorage persisted rooms but chatRooms is off", () => {
    setupMockChat({ sessions: [], filteredSessions: [] });
    localStorage.setItem("fusion:chat-scope", "rooms");

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{}} />);

    expect(screen.queryByTestId("chat-sidebar-scope-rooms")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-search-input")).toBeInTheDocument();
  });

  it("persists scope in localStorage and restores Rooms on next mount", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    const { unmount } = render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    expect(localStorage.getItem("fusion:chat-scope")).toBe("rooms");

    unmount();

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.getByTestId("chat-sidebar-scope-rooms")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("chat-sidebar-rooms-empty")).toBeInTheDocument();
  });
});

describe("resizable sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders desktop resize handle with separator ARIA attributes", () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const handle = screen.getByRole("separator", { name: "Resize chat sidebar" });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuemin", "180");
    expect(handle).toHaveAttribute("aria-valuemax", "500");
    expect(handle).toHaveAttribute("aria-valuenow", "280");
    expect(handle).toHaveAttribute("tabindex", "0");

    viewportSpy.mockRestore();
  });

  it("updates sidebar width while dragging", () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const handle = screen.getByRole("separator", { name: "Resize chat sidebar" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 280 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 360 });

    const sidebar = document.querySelector(".chat-sidebar") as HTMLElement;
    expect(sidebar.style.width).toBe("360px");
    expect(handle).toHaveAttribute("aria-valuenow", "360");

    viewportSpy.mockRestore();
  });

  it("clamps width between min and max", () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const handle = screen.getByRole("separator", { name: "Resize chat sidebar" });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 280 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: -1000 });
    expect((document.querySelector(".chat-sidebar") as HTMLElement).style.width).toBe("180px");

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 280 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 2000 });
    expect((document.querySelector(".chat-sidebar") as HTMLElement).style.width).toBe("500px");

    viewportSpy.mockRestore();
  });

  it("persists width to localStorage on pointer up", () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const handle = screen.getByRole("separator", { name: "Resize chat sidebar" });
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 280 });
      fireEvent.pointerMove(document, { pointerId: 1, clientX: 360 });
      fireEvent.pointerUp(document, { pointerId: 1, clientX: 360 });
    });

    expect(localStorage.getItem("fusion:chat-sidebar-width")).toBe("360");

    viewportSpy.mockRestore();
  });

  it("restores persisted width on mount", () => {
    const viewportSpy = mockViewportMode("desktop");
    localStorage.setItem("fusion:chat-sidebar-width", "350");
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect((document.querySelector(".chat-sidebar") as HTMLElement).style.width).toBe("350px");

    viewportSpy.mockRestore();
  });

  it("does not render resize handle on mobile", () => {
    const viewportSpy = mockViewportMode("mobile");
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByRole("separator", { name: "Resize chat sidebar" })).toBeNull();

    viewportSpy.mockRestore();
  });
});

describe("thread header New Chat button", () => {
  const activeSession = { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" };

  it("renders New Chat button in thread header on desktop when session is active", () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ activeSession });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const btn = screen.getByTestId("chat-thread-new-chat-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("New Chat");
    expect(btn).toHaveClass("btn", "btn-sm", "btn-primary");

    viewportSpy.mockRestore();
  });

  it("clicking thread header New Chat button opens the NewChatDialog", () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ activeSession });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const btn = screen.getByTestId("chat-thread-new-chat-btn");
    fireEvent.click(btn);

    expect(screen.getByTestId("chat-new-dialog-mode-toggle")).toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("does not render New Chat button in thread header on mobile", () => {
    const viewportSpy = mockViewportMode("mobile");
    setupMockChat({ activeSession });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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
      matches: query === "(max-width: 768px)",
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

  it("mobile mode: does not render thread header when no active session (list view)", () => {
    const restoreMatchMedia = mockMobileViewport();
    try {
      setupMockChat({
        sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        activeSession: null,
      });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Thread header should not be rendered when there's no active session
      expect(document.querySelector(".chat-thread-header")).not.toBeInTheDocument();
      // Back button should not be visible
      expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: renders thread header with back button when session is active", () => {
    const restoreMatchMedia = mockMobileViewport();
    try {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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
      const initialRender = render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
      expect(screen.queryByTestId("chat-mobile-session-trigger")).not.toBeInTheDocument();
      expect(screen.getByText("#backend")).toBeInTheDocument();
    } finally {
      localStorage.setItem("fusion:chat-scope", "direct");
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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "Hello mobile room" } });
      input.focus();

      const sendButton = screen.getByTestId("chat-send-btn");
      fireEvent.touchStart(sendButton);
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(sendRoomMessage).toHaveBeenCalledTimes(1);
        expect(sendRoomMessage).toHaveBeenCalledWith("Hello mobile room");
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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const thread = document.querySelector(".chat-thread") as HTMLDivElement;
      expect(thread).toBeInTheDocument();
      expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("");

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
        expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("284px");
        expect(thread.style.getPropertyValue("--vv-height")).toBe("560px");
      });

      // Blur to signal keyboard dismissal
      textarea.blur();

      Object.defineProperty(mockVV, "height", {
        value: 844,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("");
        expect(thread.style.getPropertyValue("--vv-height")).toBe("");
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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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
      Object.defineProperty(window, "innerHeight", { value: 560, writable: true, configurable: true });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(true);
      });

      textarea.blur();
      act(() => {
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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(mockVV.addEventListener).not.toHaveBeenCalled();
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("desktop mode: renders thread header even without active session (shows empty state)", () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        activeSession: null,
      });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

  it("desktop mode: thread header is visible with active session", () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

  it("FN-3884: snaps to bottom when opening a session with loaded messages", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      const { rerender } = render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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
      const { rerender } = render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      await waitFor(() => {
        expect(scrollTopValue).toBe(1180);
      });
    } finally {
      restoreMatchMedia.mockRestore();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
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

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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
      while (rafQueue.length > 0) {
        const cb = rafQueue.shift();
        cb?.(performance.now());
      }

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
      const { rerender } = render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

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

      const { rerender } = render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
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
    const mobileRegex = /@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/g;
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
    const mobileRegex = /@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/g;
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

  it("mobile .chat-sidebar uses height: 100% instead of max-height: 40vh", () => {
    expect(mobileRuleContains(".chat-sidebar", "height: 100%")).toBe(true);
    expect(mobileRuleNotContains(".chat-sidebar", "max-height: 40vh")).toBe(true);
  });

  it("mobile .chat-sidebar-header is hidden", () => {
    expect(mobileRuleContains(".chat-sidebar-header", "display: none")).toBe(true);
  });

  it("mobile .chat-sidebar-search remains visible (FN-4120)", () => {
    expect(mobileRuleNotContains(".chat-sidebar-search", "display: none")).toBe(true);
  });

  it("mobile .chat-sidebar-search keeps a token-based touch target (FN-4120)", () => {
    expect(mobileRuleContains(".chat-sidebar-search", "min-height: calc(var(--space-2xl) + var(--space-xs))")).toBe(true);
  });

  it("mobile .chat-sidebar-list has flex: 1 and overflow-y: auto for scrolling", () => {
    expect(mobileRuleContains(".chat-sidebar-list", "flex: 1")).toBe(true);
    expect(mobileRuleContains(".chat-sidebar-list", "overflow-y: auto")).toBe(true);
    expect(mobileRuleContains(".chat-sidebar-list", "min-height: 0")).toBe(true);
  });

  it("mobile .chat-sidebar-footer exists with display block and border-top", () => {
    expect(mobileRuleContains(".chat-sidebar-footer", "display: block")).toBe(true);
    expect(mobileRuleContains(".chat-sidebar-footer", "border-top")).toBe(true);
  });

  it("mobile .chat-sidebar-footer-btn stays full-width and centered", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-sidebar-footer\s+\.chat-sidebar-footer-btn\s*\{[^}]*width:\s*100%[^}]*justify-content:\s*center/);
  });

  it("mobile does not override assistant render toggle visibility", () => {
    expect(mobileRuleNotContains(".chat-message-render-toggle", "display: inline-flex")).toBe(true);
  });

  it("mobile keeps ChatView dialog backdrop centered with safe-area padding", () => {
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "align-items: center")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "justify-content: center")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "overflow-y: auto")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "padding-top: max(var(--space-md), env(safe-area-inset-top, 0px))")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "padding-bottom: max(var(--space-md), env(safe-area-inset-bottom, 0px))")).toBe(true);
  });

  it("mobile constrains ChatView dialog height and allows internal scrolling", () => {
    expect(mobileRuleContains(".chat-view-dialog", "max-height: calc(100dvh - (var(--space-md) * 2) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog", "display: flex")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog", "flex-direction: column")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog", "overflow-y: auto")).toBe(true);
  });

  it("mobile ChatView dialog rules do not set full-screen heights", () => {
    expect(mobileRuleNotContains(".chat-view-dialog", "height: 100vh")).toBe(true);
    expect(mobileRuleNotContains(".chat-view-dialog", "height: 100dvh")).toBe(true);
  });

  it("mobile includes keyboard-aware chat-thread height rule", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread--keyboard-active\s*\{[^}]*--vv-height/);
  });

  it("mobile widens chat bubbles for readability", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message\s*\{[^}]*max-width:\s*90%/);
  });

  it("mobile keeps thread-header identity and render toggle inline", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread-header\s*\{[^}]*flex-wrap:\s*nowrap/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread-header-identity\s*\{[^}]*flex:\s*1\s+1\s+auto[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread-header-render-toggle\s*\{[^}]*flex-shrink:\s*0/);
  });

  it("mobile keeps response copy action visible and touch-friendly", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message-copy-action\s*\{[^}]*opacity:\s*1/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message-copy-action\s*\{[^}]*min-width:\s*calc\(var\(--space-lg\)\s*\*\s*2\.25\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message-copy-action\s*\{[^}]*min-height:\s*calc\(var\(--space-lg\)\s*\*\s*2\.25\)/);
  });
});

/**
 * Tests for ChatView component: sidebar, session list, message thread,
 * new chat dialog, and input handling.
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();
import * as useChatModule from "../../hooks/useChat";
import * as useAgentsModule from "../../hooks/useAgents";
import type { Agent } from "../../api";

// Mock the hooks
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useAgents");

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseAgents = vi.mocked(useAgentsModule.useAgents);

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
  };
});

const mockAgents: Agent[] = [
  {
    id: "agent-001",
    name: "Agent One",
    role: "executor",
    state: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
  {
    id: "agent-002",
    name: "Agent Two",
    role: "reviewer",
    state: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
];

const defaultChatState = {
  sessions: [],
  activeSession: null,
  sessionsLoading: false,
  messages: [],
  messagesLoading: false,
  isStreaming: false,
  streamingText: "",
  streamingThinking: "",
  selectSession: vi.fn(),
  createSession: vi.fn().mockResolvedValue({ id: "session-new", agentId: "agent-001" }),
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  sendMessage: vi.fn(),
  loadMoreMessages: vi.fn(),
  hasMoreMessages: false,
  searchQuery: "",
  setSearchQuery: vi.fn(),
  filteredSessions: [],
  refreshSessions: vi.fn(),
};

function setupMockChat(overrides: Partial<typeof defaultChatState> = {}) {
  const state = { ...defaultChatState, ...overrides };
  mockUseChat.mockReturnValue(state as any);
}

function setupMockAgents() {
  mockUseAgents.mockReturnValue({
    agents: mockAgents,
    activeAgents: mockAgents,
    stats: null,
    isLoading: false,
    loadAgents: vi.fn(),
    loadStats: vi.fn(),
  } as any);
}

describe("ChatView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockAgents();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when no session is selected", () => {
    setupMockChat({ sessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    expect(screen.getByTestId("chat-new-btn")).toBeInTheDocument();
  });

  it("renders session list in sidebar", () => {
    setupMockChat({
      sessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "session-002", agentId: "agent-002", status: "active", title: "Another Chat", updatedAt: "2026-04-07T00:00:00.000Z" },
      ],
      filteredSessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "session-002", agentId: "agent-002", status: "active", title: "Another Chat", updatedAt: "2026-04-07T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Test Chat")).toBeInTheDocument();
    expect(screen.getByText("Another Chat")).toBeInTheDocument();
  });

  it("calls selectSession when clicking a session", async () => {
    const selectSession = vi.fn();
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      selectSession,
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByText("Test Chat"));

    expect(selectSession).toHaveBeenCalledWith("session-001");
  });

  it("highlights active session", () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
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
    const dialog = document.querySelector(".chat-new-dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog!).getByText("Agent")).toBeInTheDocument();
  });

  it("creates session and closes dialog", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "agent-001" });
    setupMockChat({ sessions: [], filteredSessions: [], createSession });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    const dialog = document.querySelector(".chat-new-dialog");
    const select = within(dialog!).getByRole("combobox") as HTMLSelectElement;
    await userEvent.selectOptions(select, "agent-001");

    await userEvent.click(within(dialog!).getByText("Create"));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        agentId: "agent-001",
        title: undefined,
        modelProvider: undefined,
        modelId: undefined,
      });
    });
  });

  it("renders messages for active session", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi there!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
  });

  it("sends message on Enter key", async () => {
    const sendMessage = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      sendMessage,
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "Hello world{enter}");

    expect(sendMessage).toHaveBeenCalledWith("Hello world");
  });

  it("does not send on Shift+Enter", async () => {
    const sendMessage = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      sendMessage,
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "Hello world{Shift>}{Enter}{/Shift}");

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("disables send button when input is empty", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sendButton = screen.getByTestId("chat-send-btn");
    expect(sendButton).toBeDisabled();
  });

  it("disables send button when streaming", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: true,
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sendButton = screen.getByTestId("chat-send-btn");
    expect(sendButton).toBeDisabled();
  });

  it("shows streaming indicator when isStreaming is true", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
      isStreaming: true,
      streamingText: "Typing...",
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    // Streaming message should show
    const streamingMessage = document.querySelector(".chat-message--streaming");
    expect(streamingMessage).toBeInTheDocument();
    expect(streamingMessage?.textContent).toContain("Typing");
  });

  it("shows thinking blocks collapsed by default", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Here's my response", thinkingOutput: "I need to think about this...", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const details = screen.getByText("Here's my response").parentElement?.querySelector("details");
    expect(details).toBeInTheDocument();
    expect(details).toHaveProperty("open", false);
  });

  it("filters sessions by search query", async () => {
    setupMockChat({
      sessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Frontend work", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "session-002", agentId: "agent-002", status: "active", title: "Backend API", updatedAt: "2026-04-07T00:00:00.000Z" },
      ],
      filteredSessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Frontend work", updatedAt: "2026-04-08T00:00:00.000Z" },
      ],
      searchQuery: "frontend",
      setSearchQuery: vi.fn(),
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Frontend work")).toBeInTheDocument();
    expect(screen.queryByText("Backend API")).not.toBeInTheDocument();
  });

  it("shows empty state agent selector and Start Chat button", () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    // Find the New Chat button in the empty state section
    const emptyState = document.querySelector(".chat-empty-state");
    expect(within(emptyState!).getByRole("button", { name: /new chat/i })).toBeInTheDocument();
  });

  it("shows context menu on right-click", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
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
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
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
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    await userEvent.pointer({ target: sessionItem, keys: "[MouseRight]" });

    await userEvent.click(screen.getByTestId("chat-context-delete"));

    // Dialog should be open
    const dialog = document.querySelector(".chat-new-dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog!).getByText("Delete Conversation?")).toBeInTheDocument();
  });
});

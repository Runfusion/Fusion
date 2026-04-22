/**
 * Tests for ChatView component: sidebar, session list, message thread,
 * new chat dialog, and input handling.
 */

import fs from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import type { DiscoveredSkill } from "@fusion/dashboard";

const stylesPath = path.resolve(__dirname, "../../styles.css");

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();
import * as useChatModule from "../../hooks/useChat";
import * as apiModule from "../../api";

// Mock the hooks
vi.mock("../../hooks/useChat");

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockFetchDiscoveredSkills = vi.mocked(apiModule.fetchDiscoveredSkills);

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

const defaultChatState = {
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
  createSession: vi.fn().mockResolvedValue({ id: "session-new", agentId: "__fn_agent__" }),
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

const activeSessionFixture = {
  id: "session-001",
  agentId: "agent-001",
  status: "active",
  title: "Test Chat",
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

function setupMockChat(overrides: Partial<typeof defaultChatState> = {}) {
  const state = { ...defaultChatState, ...overrides };
  mockUseChat.mockReturnValue(state as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchDiscoveredSkills.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
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

    const dialog = document.querySelector(".chat-new-dialog");

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

    const dialog = document.querySelector(".chat-new-dialog");

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

    const dialog = document.querySelector(".chat-new-dialog");

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

    const dialog = document.querySelector(".chat-new-dialog");

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

    const dialog = document.querySelector(".chat-new-dialog");

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

    const dialog = document.querySelector(".chat-new-dialog");

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

    const dialog = document.querySelector(".chat-new-dialog");

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

  it("renders tool calls from persisted messages", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
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
    const preview = document.querySelector(".chat-tool-call-preview");
    expect(preview).toHaveTextContent("result: contents");
  });

  it("renders streaming tool calls", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
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

    const streamingBubble = document.querySelector(".chat-message--streaming");
    expect(streamingBubble).toBeInTheDocument();
    expect(within(streamingBubble as HTMLElement).getByText("read")).toBeInTheDocument();
    const preview = (streamingBubble as HTMLElement).querySelector(".chat-tool-call-preview");
    expect(preview).toHaveTextContent("path=foo.ts");
  });

  it("completed tool calls are collapsed by default", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
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

    const details = document.querySelector(".chat-tool-call") as HTMLDetailsElement | null;
    expect(details).toBeInTheDocument();
    expect(details?.open).toBe(false);
  });

  it("running tool calls show running indicator", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
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
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Tool Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
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
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Agent Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello from Alpha", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const avatar = document.querySelector(".chat-message-avatar");
    expect(avatar).toBeInTheDocument();

    await waitFor(() => {
      expect(within(avatar!).getByText("Alpha")).toBeInTheDocument();
    });
    expect(within(avatar!).queryByText("Fusion")).not.toBeInTheDocument();
  });

  it("shows Fusion in assistant message avatar for fn agent sessions", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "__fn_agent__", status: "active", title: "Fusion Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Built-in assistant response", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const avatar = document.querySelector(".chat-message-avatar");
    expect(avatar).toBeInTheDocument();
    expect(within(avatar!).getByText("Fusion")).toBeInTheDocument();
  });

  it("shows formatted model name in assistant message avatar for fn agent sessions", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Fusion Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Built-in assistant response", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const avatar = document.querySelector(".chat-message-avatar");
    expect(avatar).toBeInTheDocument();

    await waitFor(() => {
      expect(within(avatar!).getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    });
    expect(within(avatar!).queryByText("Fusion")).not.toBeInTheDocument();
    expect(avatar?.querySelector(".chat-model-tag")).toBeNull();
  });

  it("shows resolved agent name in streaming assistant avatar", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Agent Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Think", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
      isStreaming: true,
      streamingText: "Thinking...",
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const avatar = document.querySelector(".chat-message--streaming .chat-message-avatar");
    expect(avatar).toBeInTheDocument();

    await waitFor(() => {
      expect(within(avatar!).getByText("Alpha")).toBeInTheDocument();
    });
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

    it("renders known @mentions as highlighted chips", async () => {
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
        expect(screen.getByText("@Alpha")).toHaveClass("chat-mention-chip");
      });
      expect(screen.getByText(/@Unknown/)).not.toHaveClass("chat-mention-chip");
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
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sendButton = screen.getByTestId("chat-send-btn");
    expect(sendButton).toBeDisabled();
  });

  it("renders stop button when streaming", () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
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
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
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
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: false,
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-send-btn")).toBeInTheDocument();
  });

  it("renders pending message indicator and dismisses it", async () => {
    const clearPendingMessage = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
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
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
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
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
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

  describe("streaming states", () => {
    it("shows waiting indicator when streaming starts before text arrives", () => {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "",
      });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Streaming message should show with "Connecting..." text
      const streamingMessage = document.querySelector(".chat-message--streaming");
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
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "analyzing the request...",
      });

      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Streaming message should show with "Thinking..." text
      const streamingMessage = document.querySelector(".chat-message--streaming");
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

  it("shows empty state with Start Chat button (no inline agent selector)", () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    // Find the New Chat button in the empty state section
    const emptyState = document.querySelector(".chat-empty-state");
    expect(within(emptyState!).getByRole("button", { name: /new chat/i })).toBeInTheDocument();
    // Should NOT have an agent selector in empty state
    expect(emptyState?.querySelector("select")).toBeNull();
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
      }],
      filteredSessions: [{
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "My Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        updatedAt: "2026-04-08T00:00:00.000Z",
      }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    expect(within(sessionItem).getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    expect(within(sessionItem).queryByText("Fusion")).not.toBeInTheDocument();
  });

  it("shows Fusion fallback for fn agent sessions in sidebar without model info", () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "__fn_agent__", status: "active", title: "My Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "__fn_agent__", status: "active", title: "My Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    expect(within(sessionItem).getByText("Fusion")).toBeInTheDocument();
  });

  it("shows agent ID for non-fn agent sessions in sidebar", () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "my-custom-agent", status: "active", title: "Custom Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "my-custom-agent", status: "active", title: "Custom Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
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
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const title = document.querySelector(".chat-thread-header-title");
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
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const headerModelTag = document.querySelector(".chat-thread-header .chat-model-tag");
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
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const title = document.querySelector(".chat-thread-header-title");
    expect(title).toHaveTextContent("Claude Sonnet 4.5");

    const headerModelTag = document.querySelector(".chat-thread-header .chat-model-tag");
    expect(headerModelTag).toBeNull();
  });

  it("does not show model tag when session has no model", () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test Chat",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag");
    expect(modelTag).not.toBeInTheDocument();
  });

  it("shows model tag in message avatar when non-fn session has model", () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "agent-001",
        status: "active",
        title: "Agent Chat",
        modelProvider: "openai",
        modelId: "gpt-4o",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const avatar = document.querySelector(".chat-message-avatar");
    expect(avatar).toBeInTheDocument();
    expect(avatar?.querySelector(".chat-model-tag")?.textContent).toContain("GPT");
  });

  it("does not show duplicate model tag in message avatar for fn agent sessions", () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test Chat",
        modelProvider: "openai",
        modelId: "gpt-4o",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const avatar = document.querySelector(".chat-message-avatar");
    expect(avatar).toBeInTheDocument();
    expect(within(avatar!).getByText("GPT-4o")).toBeInTheDocument();
    expect(avatar?.querySelector(".chat-model-tag")).toBeNull();
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
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag");
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
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag");
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
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag");
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
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag");
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
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag");
    expect(modelTag).not.toBeInTheDocument();
  });
});

describe("Chat Session Delete Button", () => {
  it("renders delete button on each session item", () => {
    setupMockChat({
      sessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat 1", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "session-002", agentId: "agent-002", status: "active", title: "Test Chat 2", updatedAt: "2026-04-08T00:00:00.000Z" },
      ],
      filteredSessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat 1", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "session-002", agentId: "agent-002", status: "active", title: "Test Chat 2", updatedAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const deleteButtons = screen.getAllByTestId("chat-session-delete-btn");
    expect(deleteButtons.length).toBe(2);
  });

  it("clicking delete button shows confirmation dialog", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const deleteButton = screen.getByTestId("chat-session-delete-btn");
    await userEvent.click(deleteButton);

    // Dialog should be open
    const dialog = document.querySelector(".chat-new-dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog!).getByText("Delete Conversation?")).toBeInTheDocument();
  });

  it("clicking delete button does not select the session", async () => {
    const selectSession = vi.fn();
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
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
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", updatedAt: "2026-04-08T00:00:00.000Z" }],
      deleteSession,
    });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const deleteButton = screen.getByTestId("chat-session-delete-btn");
    await userEvent.click(deleteButton);

    // Click confirm in dialog
    const dialog = document.querySelector(".chat-new-dialog");
    await userEvent.click(within(dialog!).getByText("Delete"));

    expect(deleteSession).toHaveBeenCalledWith("session-001");
  });
});

describe("Chat Session Delete Button CSS", () => {
  const css = fs.readFileSync(stylesPath, "utf-8");

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

describe("ChatView CSS — nested flexbox scrolling fix", () => {
  const css = fs.readFileSync(stylesPath, "utf-8");

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

    const callsBeforeRerender = apiModule.fetchAgents.mock.calls.length;

    // Rerender with proj-002
    rerender(<ChatView projectId="proj-002" addToast={vi.fn()} />);

    await waitFor(() => {
      expect(apiModule.fetchAgents).toHaveBeenCalledWith(undefined, "proj-002");
    });

    // Should have made an additional fetch call
    expect(apiModule.fetchAgents.mock.calls.length).toBeGreaterThan(callsBeforeRerender);
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
    const closeBtn = document.querySelector(".chat-new-dialog-backdrop");
    if (closeBtn) {
      await userEvent.click(closeBtn);
    }

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    await waitFor(() => {
      expect(apiModule.fetchAgents).toHaveBeenCalledWith(undefined, "proj-002");
    });
  });
});

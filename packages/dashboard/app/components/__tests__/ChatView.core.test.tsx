/*
FNXC:DashboardTests 2026-06-25-16:30:
ChatView suite split 1/5 (core) (was ChatView.test.tsx). Shares ChatView.test-harness for fixtures,
helpers, vi.mocked handles, and installChatViewEnv(). vi.mock factories stay inline & self
-contained here (see harness header for why delegating them triggers a TDZ ReferenceError).
*/

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { ChatView } from "../ChatView";
import type { DiscoveredSkill } from "@fusion/dashboard";
import type { UseChatReturn, ChatSessionInfo } from "../../hooks/useChat";
import { loadAllAppCss } from "../../test/cssFixture";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import { SWR_CACHE_KEYS, writeCache } from "../../utils/swrCache";
import {
  renderWithAct,
  setupMockChat,
  setupMockRooms,
  mockViewportMode,
  activeSessionFixture,
  createMockSkill,
  defaultChatState,
  defaultModelsResponse,
  mockUseChat,
  mockFetchModels,
  mockFetchDiscoveredSkills,
  mockCreateObjectURL,
  mockRevokeObjectURL,
  mockClipboardWriteText,
  installChatViewEnv,
} from "./ChatView.test-harness";

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

// Mock fetchAgents for new chat dialog
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
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

installChatViewEnv();

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

  // FNXC:ChatRenderToggle 2026-07-04-00:00: The thread-header markdown/plain
  // toggle was removed per FN-7541. Chat now always renders Markdown
  // (forcePlain={false} everywhere), so these regression tests assert the
  // toggle is gone and Markdown rendering stays intact for both persisted
  // and streaming assistant bubbles, on the desktop surface.
  it("has no thread-header render toggle and still renders assistant Markdown", async () => {
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

    expect(screen.queryByTestId("chat-thread-render-toggle")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("chat-message-render-toggle")).toHaveLength(0);
    expect(within(firstBubble).getByText("First", { selector: "strong" })).toBeInTheDocument();
    expect(within(secondBubble).getByText("Second", { selector: "strong" })).toBeInTheDocument();
  });

  it("has no thread-header render toggle and still renders the streaming bubble as Markdown", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "**Persisted**", createdAt: "2026-04-08T00:00:00.000Z" }],
      isStreaming: true,
      streamingText: "**Live** stream",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const persistedBubble = screen.getByTestId("chat-message-msg-001");
    const streamingBubble = document.querySelector(".chat-message--streaming") as HTMLElement;

    expect(screen.queryByTestId("chat-thread-render-toggle")).not.toBeInTheDocument();
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

  it("renders assistant, user, streaming, and failure bubbles with the width-targeting classes", async () => {
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [
        { id: "msg-user", sessionId: "session-001", role: "user", content: "Question", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-assistant", sessionId: "session-001", role: "assistant", content: "Answer", createdAt: "2026-04-08T00:00:01.000Z" },
        {
          id: "msg-failure",
          sessionId: "session-001",
          role: "assistant",
          content: "Failed answer",
          failureInfo: { summary: "Failed answer", detail: "Provider failed" },
          createdAt: "2026-04-08T00:00:02.000Z",
        },
      ],
      isStreaming: true,
      streamingText: "Live answer",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-message-msg-user")).toHaveClass("chat-message", "chat-message--user");
    expect(screen.getByTestId("chat-message-msg-assistant")).toHaveClass("chat-message", "chat-message--assistant");
    expect(screen.getByTestId("chat-message-msg-failure")).toHaveClass(
      "chat-message",
      "chat-message--assistant",
      "chat-message--failure",
    );
    expect(document.querySelector(".chat-message--streaming")).toHaveClass(
      "chat-message",
      "chat-message--assistant",
      "chat-message--streaming",
    );
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

  // Extracted late ChatView interaction describes live in ChatView.core-interactions.test.tsx.
});

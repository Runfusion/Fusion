/*
FNXC:DashboardTests 2026-06-25-16:30:
ChatView suite split 1/3 (core) (was ChatView.test.tsx). Shares ChatView.test-harness for fixtures,
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
    const newChatButton = screen.getByTestId("chat-new-btn");

    expect(header).toBeInTheDocument();
    expect(newChatButton.closest(".view-header")).toBeInTheDocument();
    expect(providerIcon).toBeInTheDocument();
    expect(within(identity).getByText("Agent Chat")).toBeInTheDocument();
    expect(modelTag).toBeInTheDocument();
    expect(modelTag).toHaveTextContent("Claude Sonnet 4.5");
    expect(toggle).toBeInTheDocument();
    expect(header?.children[header.children.length - 1]).toBe(toggle);
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

describe("ChatView CSS — tablet assistant bubble width", () => {
  const css = loadAllAppCss();

  it("widens assistant, streaming, and failure bubbles on tablet containers while preserving user and mobile caps", async () => {
    const baseMessageRule = css.match(/\.chat-message\s*\{([^}]*)\}/);
    const userRule = css.match(/\.chat-message--user\s*\{([^}]*)\}/);
    const tabletRule = css.match(
      /@container\s+chat-view\s+\(min-width:\s*48\.0625rem\)\s+and\s+\(max-width:\s*64rem\)\s*\{([\s\S]*?)\n\}/,
    );

    expect(baseMessageRule?.[1]).toContain("max-width: 75%");
    expect(userRule?.[1]).toContain("align-self: flex-end");
    expect(userRule?.[1]).not.toContain("max-width");
    expect(tabletRule?.[1]).toMatch(
      /\.chat-message--assistant,\s*\.chat-message--streaming,\s*\.chat-message--failure\s*\{[^}]*max-width:\s*88%/,
    );
    expect(tabletRule?.[1]).not.toMatch(/\.chat-message--user\s*\{[^}]*max-width/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message\s*\{[^}]*max-width:\s*90%/);
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

  it("renders the header Direct/Rooms toggle with visible borders", async () => {
    const headerScopeRule = findRule(".chat-view-header-scope-toggle");
    const headerScopeButtonRule = findRule(".chat-view-header-scope-toggle .chat-sidebar-scope-btn");
    const headerActiveScopeRule = findRule(".chat-view-header-scope-toggle .chat-sidebar-scope-btn--active");

    expect(headerScopeRule).toContain("border: 1px solid var(--border)");
    expect(headerScopeRule).toContain("height: var(--view-header-content-row, 28px)");
    expect(headerScopeButtonRule).toContain("border: 1px solid transparent");
    expect(headerScopeButtonRule).toContain("height: 100%");
    expect(headerActiveScopeRule).toContain("border-color: var(--todo)");
  });

  it("collapses header Direct/Rooms labels to icons at very narrow widths", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*460px\)[\s\S]*?\.chat-view-header-scope-toggle\s*\{[^}]*width:\s*72px/);
    expect(css).toMatch(/@media\s*\(max-width:\s*460px\)[\s\S]*?\.chat-view-header-scope-toggle \.chat-sidebar-scope-btn span\s*\{[^}]*clip:\s*rect\(0 0 0 0\)/);
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


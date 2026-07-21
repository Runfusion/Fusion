/*
FNXC:DashboardTests 2026-06-25-17:44:
ChatView suite split 5/5 (model/delete/css contracts) extracts model-tag, session-delete, and CSS-contract describes from ChatView.core.test.tsx so the cap-crosser is split into focused siblings rather than grandfathered. Shares ChatView.test-harness; vi.mock factories stay inline and self-contained per the harness TDZ warning.
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

describe("Chat pinned session sections", () => {
  const pinnedAt = "2026-07-19T00:00:00.000Z";
  const mixedSessions: ChatSessionInfo[] = [
    { id: "session-pinned", agentId: "agent-001", status: "active", title: "Pinned", pinnedAt, createdAt: pinnedAt, updatedAt: pinnedAt },
    { id: "session-recent", agentId: "agent-002", status: "active", title: "Recent", createdAt: pinnedAt, updatedAt: pinnedAt },
  ];

  it("separates pinned and recent direct sessions on desktop and omits empty shells", async () => {
    setupMockChat({ activeSession: mixedSessions[0], sessions: mixedSessions, filteredSessions: mixedSessions });

    const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const pinned = screen.getByTestId("chat-session-section-pinned");
    const recent = screen.getByTestId("chat-session-section-recent");
    expect(pinned).toHaveTextContent("Pinned");
    expect(within(pinned).getByTestId("chat-session-session-pinned")).toBeInTheDocument();
    expect(within(recent).getByTestId("chat-session-session-recent")).toBeInTheDocument();
    expect(within(recent).getByTestId("chat-recent-divider")).toHaveTextContent("Recent");

    setupMockChat({ activeSession: mixedSessions[1], sessions: [mixedSessions[1]], filteredSessions: [mixedSessions[1]] });
    await act(async () => {
      view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    });
    expect(screen.queryByTestId("chat-session-section-pinned")).toBeNull();
    expect(screen.getByTestId("chat-session-section-recent")).toBeInTheDocument();
  });

  it("separates pinned and recent direct sessions in the mobile switcher", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    try {
      setupMockChat({ activeSession: mixedSessions[0], sessions: mixedSessions, filteredSessions: mixedSessions });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      await userEvent.click(screen.getByTestId("chat-session-session-pinned"));
      await userEvent.click(screen.getByTestId("chat-mobile-session-trigger"));

      const pinned = screen.getByTestId("chat-mobile-session-section-pinned");
      const recent = screen.getByTestId("chat-mobile-session-section-recent");
      expect(within(pinned).getByTestId("chat-mobile-session-option-session-pinned")).toBeInTheDocument();
      expect(within(recent).getByTestId("chat-mobile-session-option-session-recent")).toBeInTheDocument();
      expect(within(recent).getByTestId("chat-mobile-recent-divider")).toHaveTextContent("Recent");
    } finally {
      restoreMatchMedia();
    }
  });
});

describe("Chat Session Action Menu", () => {
  it("renders one overflow button on each session item without an inline action cluster", async () => {
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

    expect(screen.getAllByTestId("chat-session-menu-btn")).toHaveLength(2);
    expect(document.querySelectorAll(".chat-session-actions")).toHaveLength(0);
  });

  it("preserves pinned labels and pin-limit disabling in the shared action menu", async () => {
    const pinnedAt = "2026-04-08T00:00:00.000Z";
    const sessions = [
      { id: "session-pinned", agentId: "agent-001", status: "active" as const, title: "Pinned Chat", pinnedAt, createdAt: pinnedAt, updatedAt: pinnedAt },
      { id: "session-pinned-two", agentId: "agent-002", status: "active" as const, title: "Pinned Chat Two", pinnedAt, createdAt: pinnedAt, updatedAt: pinnedAt },
      { id: "session-pinned-three", agentId: "agent-003", status: "active" as const, title: "Pinned Chat Three", pinnedAt, createdAt: pinnedAt, updatedAt: pinnedAt },
      { id: "session-unpinned", agentId: "agent-004", status: "active" as const, title: "Unpinned Chat", createdAt: pinnedAt, updatedAt: pinnedAt },
    ];
    setupMockChat({ sessions, filteredSessions: sessions, pinnedCount: 3 });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(within(screen.getByTestId("chat-session-session-pinned")).getByTestId("chat-session-menu-btn"));
    expect(screen.getByTestId("chat-context-pin")).toHaveTextContent("Unpin");

    await userEvent.click(within(screen.getByTestId("chat-session-session-pinned")).getByTestId("chat-session-menu-btn"));
    await userEvent.click(within(screen.getByTestId("chat-session-session-unpinned")).getByTestId("chat-session-menu-btn"));
    const pinButton = screen.getByTestId("chat-context-pin");
    expect(pinButton).toHaveTextContent("Pin");
    expect(pinButton).toBeDisabled();
    expect(pinButton).toHaveAttribute("title", "You can pin up to 3 conversations");
  });

  it("opens the shared labeled action menu and deletes from it", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-session-menu-btn"));

    const menu = document.querySelector(".chat-session-context-menu");
    expect(menu).toBeInTheDocument();
    expect(within(menu!).getByTestId("chat-context-pin")).toHaveTextContent("Pin");
    expect(within(menu!).getByTestId("chat-context-rename")).toHaveTextContent("Rename");
    expect(within(menu!).getByTestId("chat-context-archive")).toHaveTextContent("Archive");
    await userEvent.click(within(menu!).getByTestId("chat-context-delete"));

    // Dialog should be open
    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    expect(dialog).toBeInTheDocument();
    expect(within(dialog!).getByText("Delete Conversation?")).toBeInTheDocument();
  });

  it("clicking the action menu button does not select the session", async () => {
    const selectSession = vi.fn();
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      selectSession,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-session-menu-btn"));

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
      const initialSession: ChatSessionInfo = {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Mobile Chat",
        modelProvider: "minimax",
        modelId: "m3",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      };
      setupMockChat({
        activeSession: initialSession,
        sessions: [initialSession],
        filteredSessions: [initialSession],
        renameSession,
      });

      const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      /*
      FNXC:ChatHeader 2026-07-16-00:00:
      The mobile session switcher belongs to the direct-thread pane, not the visible session list. Drill into the active session before asserting its header controls so this rename contract matches the user flow.
      */
      await userEvent.click(screen.getByTestId("chat-session-session-001"));
      await waitFor(() => {
        expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
      });

      expect(screen.getByTestId("chat-mobile-session-trigger")).toHaveTextContent("Mobile Chat");
      expect(screen.getByTestId("chat-mobile-session-trigger")).not.toHaveTextContent("M3");
      await userEvent.click(screen.getByTestId("chat-mobile-session-trigger"));
      await userEvent.click(screen.getByTestId("chat-mobile-session-rename-session-001"));

      const input = screen.getByTestId("chat-rename-input") as HTMLInputElement;
      expect(input.value).toBe("Mobile Chat");
      await userEvent.clear(input);
      await userEvent.type(input, "Mobile Renamed");
      await userEvent.click(screen.getByTestId("chat-rename-save"));

      expect(renameSession).toHaveBeenCalledWith("session-001", "Mobile Renamed");

      const renamedSession: ChatSessionInfo = { ...initialSession, title: "Mobile Renamed" };
      setupMockChat({
        activeSession: renamedSession,
        sessions: [renamedSession],
        filteredSessions: [renamedSession],
        renameSession,
      });
      await act(async () => {
        view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      });

      const trigger = screen.getByTestId("chat-mobile-session-trigger");
      expect(trigger).toHaveTextContent("Mobile Renamed");
      expect(trigger).not.toHaveTextContent("M3");
      expect(trigger.querySelector(".chat-model-tag")).not.toBeInTheDocument();
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

    await userEvent.click(screen.getByTestId("chat-session-menu-btn"));
    await userEvent.click(screen.getByTestId("chat-context-delete"));

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

describe("ChatView CSS — responsive bubble width", () => {
  const css = loadAllAppCss();

  it("widens assistant, streaming, and failure bubbles on tablet containers while preserving desktop and mobile rules", async () => {
    const baseMessageRule = css.match(/\.chat-message\s*\{([^}]*)\}/);
    const userRule = css.match(/\.chat-message--user\s*\{([^}]*)\}/);
    const tabletRule = css.match(
      /@container\s+chat-view\s+\(min-width:\s*48\.0625rem\)\s+and\s+\(max-width:\s*64rem\)\s*\{([\s\S]*?)\n\}/,
    );

    expect(baseMessageRule?.[1]).toContain("max-width: 75%");
    expect(userRule?.[1]).toContain("align-self: flex-end");
    expect(userRule?.[1]).not.toContain("max-width");
    expect(tabletRule?.[1]).toMatch(
      /\.chat-message--assistant,\s*\.chat-message--streaming,\s*\.chat-message--failure\s*\{[^}]*max-width:\s*92%/,
    );
    expect(tabletRule?.[1]).not.toMatch(/\.chat-message--user\s*\{[^}]*max-width/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message\s*\{[^}]*max-width:\s*100%/);
  });

  it("makes all chat message variants full-width in narrow chat-view containers without changing desktop or tablet caps", async () => {
    const baseMessageRule = css.match(/\.chat-message\s*\{([^}]*)\}/);
    const narrowRule = css.match(/@container\s+chat-view\s+\(max-width:\s*30rem\)\s*\{([\s\S]*?)\n\}/);
    const tabletRule = css.match(
      /@container\s+chat-view\s+\(min-width:\s*48\.0625rem\)\s+and\s+\(max-width:\s*64rem\)\s*\{([\s\S]*?)\n\}/,
    );

    expect(baseMessageRule?.[1]).toContain("max-width: 75%");
    expect(narrowRule?.[1]).toMatch(/\.chat-message\s*\{[^}]*max-width:\s*100%/);
    expect(tabletRule?.[1]).toMatch(
      /\.chat-message--assistant,\s*\.chat-message--streaming,\s*\.chat-message--failure\s*\{[^}]*max-width:\s*92%/,
    );
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

  it("reserves one overflow-button gutter on title and preview rows", async () => {
    const titleMatch = css.match(/\.chat-session-title\s*\{([^}]*)\}/);
    const previewMatch = css.match(/\.chat-session-preview\s*\{([^}]*)\}/);
    expect(titleMatch).toBeTruthy();
    expect(previewMatch).toBeTruthy();
    expect(titleMatch?.[1]).toContain("padding-right: calc((var(--space-md) * 2) + var(--space-sm))");
    expect(previewMatch?.[1]).toContain("padding-right: calc((var(--space-md) * 2) + var(--space-sm))");
  });

  it("keeps mobile title/preview clearance matched to the overflow button", async () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-session-title,\s*\.chat-session-preview\s*\{\s*padding-right:\s*calc\(\(var\(--space-md\)\s*\*\s*2\)\s*\+\s*var\(--space-sm\)\);\s*\}/,
    );
  });
});

describe("Chat Session Row Action CSS", () => {
  const css = loadAllAppCss();

  it(".chat-session-menu-btn positions one overflow button outside row text flow", async () => {
    const menuButtonMatch = css.match(/\.chat-session-menu-btn\s*\{([^}]*)\}/);
    expect(menuButtonMatch).toBeTruthy();
    expect(menuButtonMatch![1]).toContain("position: absolute");
    expect(menuButtonMatch![1]).toContain("right: var(--space-sm)");
    expect(menuButtonMatch![1]).toContain("width: calc(var(--space-md) * 2)");
    expect(menuButtonMatch![1]).toContain("min-height: calc(var(--space-md) * 2)");
    expect(css).not.toMatch(/\.chat-session-actions\s*\{/);
    expect(css).not.toMatch(/\.chat-session-action-btn\s*\{/);
  });

  it("FN-4352: mobile row action buttons stay compact without min-size inflation", async () => {
    const mobileRegex = /@media[^{]*\(max-width:\s*768px\)[^{]*\{([\s\S]*?)\n\}/g;
    let match;
    let actionRule = "";
    while ((match = mobileRegex.exec(css)) !== null) {
      const mediaContent = match[1];
      if (mediaContent.includes(".chat-session-title")) {
        actionRule = mediaContent.match(/\.chat-session-title,\s*\.chat-session-preview\s*\{([^}]*)\}/)?.[1] ?? "";
        if (actionRule) break;
      }
    }

    expect(actionRule).toContain("padding-right: calc((var(--space-md) * 2) + var(--space-sm))");
    expect(actionRule).not.toContain("min-width:");
    expect(actionRule).not.toContain("min-height:");
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
    /*
     * FNXC:ChatMobileSessionSwitcher 2026-07-16-18:54:
     * FN-8054 intentionally uses inline flex to keep a pinned session's Pin indicator beside its title.
     * Retain the width and wrapping contracts from FN-4061 so long titles remain readable.
     */
    expect(optionTitleMatch?.[1]).toContain("width: 100%");
    expect(optionTitleMatch?.[1]).toContain("display: inline-flex");
    expect(optionTitleMatch?.[1]).toContain("align-items: center");
    expect(optionTitleMatch?.[1]).toContain("gap: var(--space-xs)");
    expect(optionTitleMatch?.[1]).toContain("line-height: normal");
    expect(optionTitleMatch?.[1]).toContain("white-space: normal");
    expect(optionTitleMatch?.[1]).toContain("overflow-wrap: anywhere");
    expect(css).not.toMatch(/\.chat-mobile-session-trigger\s+\.chat-model-tag/);
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


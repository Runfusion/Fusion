/*
FNXC:DashboardTests 2026-06-25-16:30:
ChatView suite split 2/3 (sessions + rooms + scope) (was ChatView.test.tsx). Shares ChatView.test-harness for fixtures,
helpers, vi.mocked handles, and installChatViewEnv(). vi.mock factories stay inline & self
-contained here (see harness header for why delegating them triggers a TDZ ReferenceError).
*/

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import type { ChatMessageInfo } from "../../hooks/useChat";
import { loadAllAppCss } from "../../test/cssFixture";
import * as apiModule from "../../api";
import {
  renderWithAct,
  setupMockChat,
  setupMockRooms,
  mockViewportMode,
  activeSessionFixture,
  createRoomFixture,
  renderRoomCreation,
  mockFetchModels,
  mockFetchDiscoveredSkills,
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
    expect(document.querySelector(".chat-sidebar-footer")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-new-btn").closest(".view-header")).toBeInTheDocument();
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

  it("shows rooms UI when chatRooms experimental flag is missing", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{}} />);

    expect(screen.getByTestId("chat-sidebar-scope-rooms")).toBeInTheDocument();
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
    /*
    FNXC:DashboardTests 2026-06-25-16:30:
    The Direct↔Rooms toggle swaps subtrees in ChatView's render (chatScope ternary), so the
    `.chat-messages` container UNMOUNTS on entering Rooms and a FRESH node mounts on return to
    Direct. The re-anchor effect (ChatView.tsx anchorToBottom on scope change) correctly targets
    that remounted node — whose jsdom scrollHeight is 0 unless we provide geometry at creation.
    The pre-split file masked this by mocking geometry on the pre-toggle node and only passing via
    a timing race against the remount. Install scroll geometry at the prototype level (restored in
    finally) with per-node scrollTop backing so whichever `.chat-messages` node is live — including
    the remounted one — reports scrollHeight 1200, making the re-anchor deterministically observable
    without weakening the "re-anchors to bottom" assertion.
    */
    const proto = HTMLElement.prototype;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(proto, "scrollTop");
    const scrollTopByNode = new WeakMap<HTMLElement, number>();
    const restoreGeometry = () => {
      if (originalScrollHeight) Object.defineProperty(proto, "scrollHeight", originalScrollHeight);
      if (originalClientHeight) Object.defineProperty(proto, "clientHeight", originalClientHeight);
      if (originalScrollTop) Object.defineProperty(proto, "scrollTop", originalScrollTop);
    };

    try {
      Object.defineProperty(proto, "scrollHeight", {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains("chat-messages") ? 1200 : (originalScrollHeight?.get?.call(this) ?? 0);
        },
      });
      Object.defineProperty(proto, "clientHeight", {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains("chat-messages") ? 200 : (originalClientHeight?.get?.call(this) ?? 0);
        },
      });
      Object.defineProperty(proto, "scrollTop", {
        configurable: true,
        get(this: HTMLElement) {
          return scrollTopByNode.get(this) ?? (originalScrollTop?.get?.call(this) ?? 0);
        },
        set(this: HTMLElement, value: number) {
          scrollTopByNode.set(this, value);
        },
      });

      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
        sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      // Scroll up from the bottom so the jump-to-latest affordance appears.
      messagesContainer.scrollTop = 500;
      fireEvent.scroll(messagesContainer);
      expect(screen.getByTestId("chat-jump-to-latest")).toBeInTheDocument();

      await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
      await userEvent.click(screen.getByTestId("chat-sidebar-scope-direct"));

      await waitFor(() => {
        const live = document.querySelector(".chat-messages") as HTMLDivElement;
        expect(live.scrollTop).toBe(1200);
      });
      await waitFor(() => {
        expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();
      });
    } finally {
      restoreGeometry();
    }
  });

  it("restores persisted rooms scope when chatRooms experimental flag is missing", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });
    localStorage.setItem("fusion:chat-scope", "rooms");

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{}} />);

    expect(screen.getByTestId("chat-sidebar-scope-rooms")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("chat-sidebar-rooms-empty")).toBeInTheDocument();
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

describe("Chat header New Chat button", () => {
  const activeSession = { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" };

  it("renders New Chat button in the shared header on desktop when session is active", async () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ activeSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const btn = screen.getByTestId("chat-new-btn");
    expect(btn).toBeInTheDocument();
    expect(btn.closest(".view-header")).toBeInTheDocument();
    expect(btn).toHaveTextContent("New Chat");
    expect(btn).toHaveClass("btn", "btn-sm", "btn-primary");

    viewportSpy.mockRestore();
  });

  it("clicking shared header New Chat button opens the NewChatDialog", async () => {
    const viewportSpy = mockViewportMode("desktop");
    setupMockChat({ activeSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const btn = screen.getByTestId("chat-new-btn");
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(await screen.findByTestId("chat-new-dialog-mode-toggle")).toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("does not render New Chat button in the shared header on mobile", async () => {
    const viewportSpy = mockViewportMode("mobile");
    setupMockChat({ activeSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-thread-new-chat-btn")).toBeNull();
    expect(document.querySelector(".view-header [data-testid='chat-new-btn']")).toBeNull();

    viewportSpy.mockRestore();
  });
});

describe("Chat pop-out header actions", () => {
  it("renders a pop-out action in the main Chat header", async () => {
    const onPopOut = vi.fn();
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} onPopOut={onPopOut} />);

    const button = screen.getByTestId("chat-pop-out");
    expect(button.closest(".view-header")).toBeInTheDocument();
    fireEvent.click(button);
    expect(onPopOut).toHaveBeenCalledTimes(1);
  });

  it("renders maximize, minimize, and close actions in floating Chat", async () => {
    const onMaximize = vi.fn();
    const onMinimize = vi.fn();
    const onClose = vi.fn();
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(
      <ChatView
        projectId="proj-123"
        addToast={vi.fn()}
        floating
        onMaximize={onMaximize}
        onMinimize={onMinimize}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("chat-modal-maximize"));
    fireEvent.click(screen.getByTestId("chat-modal-minimize"));
    fireEvent.click(screen.getByTestId("chat-modal-close"));
    expect(onMaximize).toHaveBeenCalledTimes(1);
    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("defines a modal-width narrow layout that mirrors mobile one-pane behavior", async () => {
    const css = loadAllAppCss();

    expect(css).toMatch(/\.chat-view--narrow \.chat-view__body\s*\{[^}]*flex-direction:\s*column;/);
    expect(css).toMatch(/\.chat-view--narrow \.chat-sidebar\s*\{[^}]*min-width:\s*100%;[^}]*border-right:\s*none;/);
    expect(css).toMatch(/\.chat-view--narrow \.chat-sidebar:not\(\.chat-sidebar--hidden\) \+ \.chat-thread\s*\{[^}]*display:\s*none;/);
    expect(css).toMatch(/\.chat-view--narrow \[data-testid="chat-modal-maximize"\]\s*\{[^}]*display:\s*none;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-view \[data-testid="chat-modal-maximize"\]\s*\{[^}]*display:\s*none;/);
  });

  it("collapses Direct/Rooms labels from ChatView container width so the header title remains visible", async () => {
    const css = loadAllAppCss();

    expect(css).toMatch(/\.chat-view\s*\{[^}]*container:\s*chat-view \/ inline-size;/);
    expect(css).toMatch(/@container\s+chat-view\s+\(max-width:\s*560px\)[\s\S]*?\.chat-view-header-scope-toggle\s*\{[^}]*width:\s*72px;/);
    expect(css).toMatch(/@container\s+chat-view\s+\(max-width:\s*560px\)[\s\S]*?\.chat-view-header-scope-toggle \.chat-sidebar-scope-btn span\s*\{[^}]*clip-path:\s*inset\(50%\);/);
  });
});


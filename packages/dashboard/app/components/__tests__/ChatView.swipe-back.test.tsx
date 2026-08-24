import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import { NavigationHistoryProvider, useNavigationHistory } from "../../hooks/useNavigationHistory";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { ChatSessionInfo } from "../../hooks/useChat";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
    fetchTasks: vi.fn().mockResolvedValue([]),
    updateGlobalSettings: vi.fn().mockResolvedValue(undefined),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
    fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
  };
});

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);

const session: ChatSessionInfo = {
  id: "session-001",
  agentId: "agent-001",
  status: "active",
  title: "Session One",
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

function mockViewport(mode: "mobile" | "desktop") {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
  }
  Object.defineProperty(window, "innerWidth", {
    value: mode === "mobile" ? 375 : 1280,
    configurable: true,
  });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches:
      mode === "mobile" &&
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

function HistoryHarness({ children }: { children: ReactNode }) {
  const history = useNavigationHistory({ enabled: true });
  return <NavigationHistoryProvider value={history}>{children}</NavigationHistoryProvider>;
}

const selectSessionSpy = vi.fn();

function mockRoomsIdle() {
  mockUseChatRooms.mockReturnValue({
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
  });
}

function StatefulChatView() {
  const [activeSessionId, setActiveSessionId] = useState("");
  const handleSelectSession = (id: string) => {
    selectSessionSpy(id);
    setActiveSessionId(id);
  };

  mockUseChat.mockImplementation(() => ({
    sessions: [session],
    activeSession: activeSessionId ? session : null,
    sessionsLoading: false,
    messages: [],
    messagesLoading: false,
    isStreaming: false,
    streamingText: "",
    streamingThinking: "",
    streamingToolCalls: [],
    selectSession: handleSelectSession,
    createSession: vi.fn(),
    archiveSession: vi.fn(),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    stopStreaming: vi.fn(),
    pendingMessages: [],
    clearPendingMessage: vi.fn(),
    loadMoreMessages: vi.fn(),
    hasMoreMessages: false,
    searchQuery: "",
    setSearchQuery: vi.fn(),
    filteredSessions: [session],
    refreshSessions: vi.fn(),
    agentsMap: new Map(),
  }));

  mockRoomsIdle();

  return <ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />;
}

function RestoredActiveSessionChatView() {
  mockUseChat.mockReturnValue({
    sessions: [session],
    activeSession: session,
    sessionsLoading: false,
    messages: [{ id: "msg-001", sessionId: session.id, role: "assistant", content: "Restored", createdAt: "2026-04-08T00:00:00.000Z" }],
    messagesLoading: false,
    isStreaming: false,
    streamingText: "",
    streamingThinking: "",
    streamingToolCalls: [],
    selectSession: selectSessionSpy,
    createSession: vi.fn(),
    archiveSession: vi.fn(),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    stopStreaming: vi.fn(),
    pendingMessages: [],
    clearPendingMessage: vi.fn(),
    loadMoreMessages: vi.fn(),
    hasMoreMessages: false,
    searchQuery: "",
    setSearchQuery: vi.fn(),
    filteredSessions: [session],
    refreshSessions: vi.fn(),
    agentsMap: new Map(),
  });
  mockRoomsIdle();

  return <ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />;
}

describe("ChatView mobile swipe-back", () => {
  const originalPushState = window.history.pushState;

  beforeEach(() => {
    vi.clearAllMocks();
    selectSessionSpy.mockClear();
    window.history.pushState = vi.fn();
  });

  it("pushes a mobile nav entry when opening a conversation and popstate returns to the list", async () => {
    mockViewport("mobile");

    render(
      <HistoryHarness>
        <StatefulChatView />
      </HistoryHarness>,
    );

    fireEvent.click(screen.getByTestId("chat-session-session-001"));

    await waitFor(() => {
      expect(window.history.pushState).toHaveBeenCalledWith(expect.objectContaining({ navIndex: 1 }), "");
    });

    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-session-session-001")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
  });

  it("consumes the drill-in history entry when visible Back returns to the list", async () => {
    mockViewport("mobile");
    const historyBackSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});

    render(
      <HistoryHarness>
        <StatefulChatView />
      </HistoryHarness>,
    );

    fireEvent.click(screen.getByTestId("chat-session-session-001"));
    await waitFor(() => expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("chat-back-btn"));

    expect(historyBackSpy).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
  });

  it("does not push a phantom mobile nav entry for a restored active session while the list is visible", async () => {
    mockViewport("mobile");

    render(
      <HistoryHarness>
        <RestoredActiveSessionChatView />
      </HistoryHarness>,
    );

    expect(screen.getByTestId("chat-session-session-001")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
    expect(window.history.pushState).not.toHaveBeenCalled();
  });

  it("uses the same Back history entry for desktop selection", async () => {
    mockViewport("desktop");

    render(
      <HistoryHarness>
        <StatefulChatView />
      </HistoryHarness>,
    );

    fireEvent.click(screen.getByTestId("chat-session-session-001"));

    await waitFor(() => {
      expect(screen.getByTestId("chat-thread-header-identity")).toBeInTheDocument();
    });
    expect(window.history.pushState).toHaveBeenCalled();
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
  });

  afterEach(() => {
    window.history.pushState = originalPushState;
  });
});

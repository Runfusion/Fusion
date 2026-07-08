import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import * as useChatModule from "../../hooks/useChat";
import * as apiModule from "../../api";
import type { UseChatReturn, ChatSessionInfo } from "../../hooks/useChat";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms", () => ({
  useChatRooms: () => ({
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
  }),
}));
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }),
}));
vi.mock("../../hooks/useNavigationHistory", () => ({
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../api", () => ({
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchTasks: vi.fn().mockResolvedValue([
    { id: "FN-5218", title: "Hash entries in chat", column: "todo" },
  ]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockFetchTasks = vi.mocked(apiModule.fetchTasks);

const activeSession: ChatSessionInfo = {
  id: "session-1",
  agentId: "agent-1",
  status: "active",
  title: "Chat",
  createdAt: "2026-05-19T00:00:00.000Z",
  updatedAt: "2026-05-19T00:00:00.000Z",
};

const defaultChatState: UseChatReturn = {
  sessions: [activeSession],
  activeSession,
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
  filteredSessions: [activeSession],
  refreshSessions: vi.fn(),
  agentsMap: new Map(),
};

describe("ChatView hash mentions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChat.mockReturnValue(defaultChatState);
  });

  it("inserts a task id from the shared hash mention popup", async () => {
    render(
      <FileBrowserProvider>
        <ChatView />
      </FileBrowserProvider>,
    );

    const textarea = screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "#FN", selectionStart: 3, selectionEnd: 3 },
    });

    await waitFor(() => {
      expect(screen.getByText("Tasks")).toBeInTheDocument();
    });
    expect(screen.getByTestId("task-mention-item-0")).toHaveTextContent("FN-5218");

    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(textarea.value).toBe("#FN-5218");
    });
    expect(mockFetchTasks).toHaveBeenCalledWith(20, 0, undefined, "FN");
  });
});

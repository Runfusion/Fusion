import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue([]),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  };
});

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);

const sessionOne: ChatSessionInfo = {
  id: "session-001",
  agentId: "agent-001",
  status: "active",
  title: "Session One",
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

const sessionTwo: ChatSessionInfo = {
  ...sessionOne,
  id: "session-002",
  title: "Session Two",
};

const roomOne = {
  id: "room-001",
  name: "Room One",
  slug: "room-one",
  description: null,
  projectId: "proj-123",
  createdBy: "agent-001",
  status: "active" as const,
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

const defaultChatState: UseChatReturn = {
  sessions: [sessionOne, sessionTwo],
  activeSession: sessionOne,
  sessionsLoading: false,
  messages: [],
  messagesLoading: false,
  isStreaming: false,
  streamingText: "",
  streamingThinking: "",
  streamingToolCalls: [],
  selectSession: vi.fn(),
  createSession: vi.fn().mockResolvedValue(sessionTwo),
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
  filteredSessions: [sessionOne, sessionTwo],
  refreshSessions: vi.fn(),
  agentsMap: new Map(),
};

const defaultRoomsState: UseChatRoomsResult = {
  rooms: [roomOne],
  roomsLoading: false,
  roomsError: null,
  activeRoom: roomOne,
  activeRoomMembers: [],
  messages: [],
  messagesLoading: false,
  selectRoom: vi.fn(),
  createRoom: vi.fn(),
  deleteRoom: vi.fn(),
  sendRoomMessage: vi.fn().mockResolvedValue(undefined),
  refreshRooms: vi.fn(),
};

function setup(chatOverrides: Partial<UseChatReturn> = {}, roomsOverrides: Partial<UseChatRoomsResult> = {}) {
  mockUseChat.mockReturnValue({ ...defaultChatState, ...chatOverrides });
  mockUseChatRooms.mockReturnValue({ ...defaultRoomsState, ...roomsOverrides });
}

function mockDesktopViewport() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
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

function renderChatView() {
  return render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
}

describe("ChatView draft persistence", () => {
  beforeEach(() => {
    _resetInitialViewportHeight();
    vi.clearAllMocks();
    localStorage.clear();
    mockDesktopViewport();
    setup();
  });

  it("writes direct-session drafts to localStorage while typing", async () => {
    renderChatView();

    await userEvent.type(screen.getByPlaceholderText("Type a message..."), "hello draft");

    await waitFor(() => {
      expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBe("hello draft");
    });
  });

  it("restores the persisted direct-session draft when remounted", () => {
    localStorage.setItem("fusion:chat-draft:direct:session-001", "saved draft");

    const { unmount } = renderChatView();
    expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("saved draft");

    unmount();
    renderChatView();

    expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("saved draft");
  });

  it("swaps the visible draft when the active direct session changes", async () => {
    localStorage.setItem("fusion:chat-draft:direct:session-002", "session two draft");

    const { rerender } = renderChatView();
    expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("");

    setup({
      activeSession: sessionTwo,
      sessions: [sessionOne, sessionTwo],
      filteredSessions: [sessionOne, sessionTwo],
    });
    rerender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("session two draft");
    });
  });

  it("clears the composer and removes the direct-session draft after send", async () => {
    const sendMessage = vi.fn();
    setup({ sendMessage });

    renderChatView();

    await userEvent.type(screen.getByPlaceholderText("Type a message..."), "send me");
    await userEvent.click(screen.getAllByTestId("chat-send-btn")[0]);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith("send me", []);
      expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("");
      expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBeNull();
    });
  });

  it("removes the storage key when the draft becomes empty", async () => {
    renderChatView();

    const textarea = screen.getByPlaceholderText("Type a message...");
    await userEvent.type(textarea, "temporary");
    await waitFor(() => {
      expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBe("temporary");
    });

    await userEvent.clear(textarea);

    await waitFor(() => {
      expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBeNull();
    });
  });

  it("uses room-scoped draft keys and keeps them isolated from direct drafts", async () => {
    localStorage.setItem("fusion:chat-scope", "rooms");
    localStorage.setItem("fusion:chat-draft:direct:session-001", "direct draft");
    localStorage.setItem("fusion:chat-draft:rooms:room-001", "room draft");

    renderChatView();

    const textarea = screen.getByPlaceholderText("Type a message...");
    expect(textarea).toHaveValue("room draft");

    await userEvent.clear(textarea);
    await userEvent.type(textarea, "updated room draft");

    await waitFor(() => {
      expect(localStorage.getItem("fusion:chat-draft:rooms:room-001")).toBe("updated room draft");
      expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBe("direct draft");
    });
  });
});

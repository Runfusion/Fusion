import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { UseChatReturn, ChatSessionInfo } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchAgents: vi.fn().mockResolvedValue([
      { id: "agent-1", name: "Alpha", role: "executor", state: "idle", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
    ]),
  };
});

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);

const activeSession: ChatSessionInfo = {
  id: "session-001",
  agentId: "agent-001",
  status: "active",
  title: "Test Chat",
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
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
  stopStreaming: vi.fn(),
  pendingMessage: "",
  clearPendingMessage: vi.fn(),
  loadMoreMessages: vi.fn(),
  hasMoreMessages: false,
  searchQuery: "",
  setSearchQuery: vi.fn(),
  filteredSessions: [activeSession],
  refreshSessions: vi.fn(),
  agentsMap: new Map(),
};

const roomA = {
  id: "room-a",
  name: "Room A",
  slug: "room-a",
  description: null,
  projectId: "proj-123",
  createdBy: "agent-1",
  status: "active" as const,
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

const defaultRoomsState: UseChatRoomsResult = {
  rooms: [roomA],
  roomsLoading: false,
  roomsError: null,
  activeRoom: roomA,
  activeRoomMembers: [],
  messages: [{ id: "rmsg-1", roomId: "room-a", role: "user", content: "Room hello", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: null, mentions: [] }],
  messagesLoading: false,
  selectRoom: vi.fn(),
  createRoom: vi.fn(),
  deleteRoom: vi.fn(),
  sendRoomMessage: vi.fn(),
  refreshRooms: vi.fn(),
};

function setup(chatOverrides: Partial<UseChatReturn> = {}, roomsOverrides: Partial<UseChatRoomsResult> = {}) {
  mockUseChat.mockReturnValue({ ...defaultChatState, ...chatOverrides });
  mockUseChatRooms.mockReturnValue({ ...defaultRoomsState, ...roomsOverrides });
}

function mockMobileViewport() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
  }
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

describe("ChatView — rooms (FN-3805..FN-3811 contract)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
    }
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
    localStorage.setItem("fusion:chat-scope", "rooms");
    setup();
  });

  it("renders Direct/Rooms toggle and allows room selection without message leakage", async () => {
    const selectRoom = vi.fn();
    const roomB = { ...roomA, id: "room-b", name: "Room B", slug: "room-b" };
    setup({}, { rooms: [roomA, roomB], selectRoom });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.getByTestId("chat-sidebar-scope-direct")).toBeInTheDocument();
    expect(screen.getByTestId("chat-sidebar-scope-rooms")).toBeInTheDocument();
    expect(screen.getByText("Room hello")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("chat-room-item-room-b"));
    expect(selectRoom).toHaveBeenCalledWith("room-b");
  });

  it("creates room via modal and sends room message on Enter", async () => {
    const createRoom = vi.fn().mockResolvedValue({ ...roomA, id: "room-new", name: "Room New", slug: "room-new" });
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({}, { createRoom, sendRoomMessage });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-create-room-btn"));
    await userEvent.type(screen.getByLabelText("Room name"), "room-new");
    await userEvent.click(await screen.findByRole("button", { name: /Alpha/i }));
    const modal = screen.getByRole("dialog", { name: "Create room" });
    await userEvent.click(within(modal).getByRole("button", { name: "Create room" }));

    await waitFor(() => {
      expect(createRoom).toHaveBeenCalledWith({ name: "room-new", memberAgentIds: ["agent-1"] });
    });

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "Hello room{enter}");

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("Hello room");
    });
  });

  it("supports delete-room confirm/cancel and rerenders messages from hook state", async () => {
    const deleteRoom = vi.fn().mockResolvedValue(undefined);
    const rerenderedRooms = {
      ...defaultRoomsState,
      messages: [{ id: "rmsg-2", roomId: "room-a", role: "assistant", content: "Updated room reply", createdAt: "2026-04-08T00:00:10.000Z", senderAgentId: "agent-2", mentions: [] }],
      deleteRoom,
    };

    mockUseChat.mockReturnValue(defaultChatState);
    mockUseChatRooms
      .mockReturnValueOnce({ ...defaultRoomsState, deleteRoom })
      .mockReturnValue(rerenderedRooms);

    const { rerender } = render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-room-delete-room-a"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteRoom).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("chat-room-delete-room-a"));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(deleteRoom).toHaveBeenCalledWith("room-a");
    });

    rerender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
    expect(screen.getByText("Updated room reply")).toBeInTheDocument();
  });

  it("shows mobile back button in room thread view", () => {
    const mediaSpy = mockMobileViewport();
    setup();

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    mediaSpy.mockRestore();
  });

  it("keeps direct mode behavior unchanged when rooms are enabled", async () => {
    localStorage.setItem("fusion:chat-scope", "direct");
    const sendMessage = vi.fn();
    const sendRoomMessage = vi.fn();
    setup({ sendMessage }, { sendRoomMessage, activeRoom: roomA });

    render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "Direct hello{enter}");

    expect(sendMessage).toHaveBeenCalledWith("Direct hello", []);
    expect(sendRoomMessage).not.toHaveBeenCalled();
  });
});

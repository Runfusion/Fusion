import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import * as headerModule from "../Header";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";

vi.mock("../../hooks/useChat", () => ({ useChat: vi.fn() }));
vi.mock("../../hooks/useChatRooms", () => ({ useChatRooms: vi.fn() }));
vi.mock("../Header", () => ({ useViewportMode: vi.fn() }));
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([{ id: "agent-1", name: "Alpha", role: "executor", state: "idle", metadata: {}, createdAt: "", updatedAt: "" }]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  updateGlobalSettings: vi.fn(),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);
const mockUseViewportMode = vi.mocked(headerModule.useViewportMode);

const mockCreateSession = vi.fn();
const mockSendMessage = vi.fn();

function buildRoomsMock(overrides: Partial<UseChatRoomsResult> = {}): UseChatRoomsResult {
  return {
    rooms: [],
    roomsLoading: false,
    roomsError: null,
    activeRoom: null,
    activeRoomMembers: [],
    messages: [],
    messagesLoading: false,
    selectRoom: vi.fn(),
    createRoom: vi.fn().mockResolvedValue({ id: "room-2", name: "product", slug: "product", description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: "", updatedAt: "" }),
    deleteRoom: vi.fn().mockResolvedValue(undefined),
    sendRoomMessage: vi.fn().mockResolvedValue(undefined),
    refreshRooms: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseViewportMode.mockReturnValue("desktop");
  mockCreateSession.mockReset();
  mockSendMessage.mockReset();
  mockUseChat.mockReturnValue({
    sessions: [], activeSession: null, sessionsLoading: false, messages: [], messagesLoading: false,
    isStreaming: false, streamingText: "", streamingThinking: "", streamingToolCalls: [],
    selectSession: vi.fn(), createSession: mockCreateSession, archiveSession: vi.fn(), deleteSession: vi.fn(),
    sendMessage: mockSendMessage, stopStreaming: vi.fn(), pendingMessage: "", clearPendingMessage: vi.fn(),
    loadMoreMessages: vi.fn(), hasMoreMessages: false, searchQuery: "", setSearchQuery: vi.fn(),
    filteredSessions: [], refreshSessions: vi.fn(), agentsMap: new Map(),
  } as any);
});

describe("ChatView rooms", () => {
  it("lists rooms and selects one", async () => {
    const roomsMock = buildRoomsMock({
      rooms: [{ id: "room-1", name: "engineering", slug: "engineering", description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: "", updatedAt: "2026-05-09T00:00:00.000Z" }],
      activeRoom: { id: "room-1", name: "engineering", slug: "engineering", description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: "", updatedAt: "2026-05-09T00:00:00.000Z" },
      messages: [{ id: "msg-1", roomId: "room-1", role: "user", content: "hello", thinkingOutput: null, metadata: null, senderAgentId: null, mentions: [], createdAt: "2026-05-09T00:00:00.000Z" }],
    });
    mockUseChatRooms.mockReturnValue(roomsMock);

    render(<ChatView addToast={vi.fn()} projectId="proj-1" experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.click(screen.getByTestId("chat-room-item-engineering"));

    expect(roomsMock.selectRoom).toHaveBeenCalledWith("room-1");
    expect(screen.getByTestId("chat-room-item-engineering")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("create room modal submits via rooms hook", async () => {
    const roomsMock = buildRoomsMock({ rooms: [] });
    mockUseChatRooms.mockReturnValue(roomsMock);

    render(<ChatView addToast={vi.fn()} projectId="proj-1" experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.click(screen.getByTestId("chat-create-room-btn"));
    await userEvent.type(screen.getByLabelText("Room name"), "product");
    await userEvent.click(await screen.findByRole("button", { name: /Alpha/i }));
    await userEvent.click(screen.getByRole("dialog", { name: "Create room" }).querySelector(".btn.btn-primary") as HTMLButtonElement);

    await waitFor(() => {
      expect(roomsMock.createRoom).toHaveBeenCalledWith({ name: "product", memberAgentIds: ["agent-1"] });
    });
  });

  it("mobile selection hides sidebar and supports back button", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    const roomsMock = buildRoomsMock({
      rooms: [{ id: "room-1", name: "engineering", slug: "engineering", description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: "", updatedAt: "2026-05-09T00:00:00.000Z" }],
      activeRoom: { id: "room-1", name: "engineering", slug: "engineering", description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: "", updatedAt: "2026-05-09T00:00:00.000Z" },
    });
    mockUseChatRooms.mockReturnValue(roomsMock);

    render(<ChatView addToast={vi.fn()} projectId="proj-1" experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.click(screen.getByTestId("chat-room-item-engineering"));

    await waitFor(() => expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument());
  });

  it("sending room message calls hook and clears input", async () => {
    const roomsMock = buildRoomsMock({
      activeRoom: { id: "room-1", name: "engineering", slug: "engineering", description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: "", updatedAt: "2026-05-09T00:00:00.000Z" },
    });
    mockUseChatRooms.mockReturnValue(roomsMock);

    render(<ChatView addToast={vi.fn()} projectId="proj-1" experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.type(screen.getByTestId("chat-input"), "hello room");
    await userEvent.click(screen.getByTestId("chat-send-btn"));

    await waitFor(() => expect(roomsMock.sendRoomMessage).toHaveBeenCalledWith("hello room"));
    await waitFor(() => expect(screen.getByTestId("chat-input")).toHaveValue(""));
  });

  it("pressing Enter in rooms sends to room and not direct session path", async () => {
    const roomsMock = buildRoomsMock({
      activeRoom: { id: "room-1", name: "engineering", slug: "engineering", description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: "", updatedAt: "2026-05-09T00:00:00.000Z" },
    });
    mockUseChatRooms.mockReturnValue(roomsMock);

    render(<ChatView addToast={vi.fn()} projectId="proj-1" experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.type(screen.getByTestId("chat-input"), "  hello room from enter  ");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(roomsMock.sendRoomMessage).toHaveBeenCalledWith("hello room from enter"));
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("opens room delete dialog without selecting room", async () => {
    const roomsMock = buildRoomsMock({
      rooms: [{ id: "room-1", name: "engineering", slug: "engineering", description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: "", updatedAt: "2026-05-09T00:00:00.000Z" }],
    });
    mockUseChatRooms.mockReturnValue(roomsMock);

    render(<ChatView addToast={vi.fn()} projectId="proj-1" experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.click(screen.getByTestId("chat-room-delete-engineering"));

    expect(screen.getByText("Delete Room?")).toBeInTheDocument();
    expect(roomsMock.selectRoom).not.toHaveBeenCalled();
  });

  it("confirms room delete", async () => {
    const roomsMock = buildRoomsMock({
      rooms: [{ id: "room-1", name: "engineering", slug: "engineering", description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: "", updatedAt: "2026-05-09T00:00:00.000Z" }],
    });
    mockUseChatRooms.mockReturnValue(roomsMock);

    render(<ChatView addToast={vi.fn()} projectId="proj-1" experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.click(screen.getByTestId("chat-room-delete-engineering"));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(roomsMock.deleteRoom).toHaveBeenCalledWith("room-1"));
    expect(roomsMock.deleteRoom).toHaveBeenCalledTimes(1);
  });

  it("cancels room delete without deleting", async () => {
    const roomsMock = buildRoomsMock({
      rooms: [{ id: "room-1", name: "engineering", slug: "engineering", description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: "", updatedAt: "2026-05-09T00:00:00.000Z" }],
    });
    mockUseChatRooms.mockReturnValue(roomsMock);

    render(<ChatView addToast={vi.fn()} projectId="proj-1" experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.click(screen.getByTestId("chat-room-delete-engineering"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Delete Room?")).not.toBeInTheDocument();
    expect(roomsMock.deleteRoom).not.toHaveBeenCalled();
  });

  it("renders newly appended messages from hook updates", async () => {
    const state = buildRoomsMock({
      activeRoom: { id: "room-1", name: "engineering", slug: "engineering", description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: "", updatedAt: "2026-05-09T00:00:00.000Z" },
      messages: [],
    });
    mockUseChatRooms.mockImplementation(() => state);

    const { rerender } = render(<ChatView addToast={vi.fn()} projectId="proj-1" experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));

    state.messages = [{ id: "msg-2", roomId: "room-1", role: "assistant", content: "reply", thinkingOutput: null, metadata: null, senderAgentId: "agent-1", mentions: [], createdAt: "2026-05-09T00:00:00.000Z" }];
    rerender(<ChatView addToast={vi.fn()} projectId="proj-1" experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.getByText("reply")).toBeInTheDocument();
  });
});

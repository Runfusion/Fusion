import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRoom, ChatRoomMember, ChatRoomMessage } from "@fusion/core";
import { useChatRooms } from "../useChatRooms";
import * as apiModule from "../../api";
import * as sseBusModule from "../../sse-bus";

vi.mock("../../api", () => ({
  fetchChatRooms: vi.fn(),
  createChatRoom: vi.fn(),
  fetchChatRoomMembers: vi.fn(),
  fetchChatRoomMessages: vi.fn(),
  deleteChatRoom: vi.fn(),
  postChatRoomMessage: vi.fn(),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(() => null),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
}));

const mockFetchChatRooms = vi.mocked(apiModule.fetchChatRooms);
const mockCreateChatRoom = vi.mocked(apiModule.createChatRoom);
const mockFetchChatRoomMembers = vi.mocked(apiModule.fetchChatRoomMembers);
const mockFetchChatRoomMessages = vi.mocked(apiModule.fetchChatRoomMessages);
const mockDeleteChatRoom = vi.mocked(apiModule.deleteChatRoom);
const mockPostChatRoomMessage = vi.mocked(apiModule.postChatRoomMessage);
const mockSubscribeSse = vi.mocked(sseBusModule.subscribeSse);

function room(id: string, name: string, updatedAt: string): ChatRoom {
  return {
    id,
    name,
    slug: name,
    description: null,
    projectId: "proj-1",
    createdBy: null,
    status: "active",
    createdAt: updatedAt,
    updatedAt,
  };
}

function roomMessage(id: string, roomId: string, content: string, createdAt = "2026-05-09T00:00:00.000Z"): ChatRoomMessage {
  return {
    id,
    roomId,
    role: "user",
    content,
    thinkingOutput: null,
    metadata: null,
    senderAgentId: null,
    mentions: [],
    createdAt,
  };
}

function roomMember(roomId: string, agentId: string): ChatRoomMember {
  return { roomId, agentId, role: "member", addedAt: "2026-05-09T00:00:00.000Z" };
}

describe("useChatRooms", () => {
  let capturedEvents: Record<string, (event: MessageEvent) => void> = {};
  let unsubscribe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    capturedEvents = {};
    unsubscribe = vi.fn();
    mockSubscribeSse.mockImplementation((_url, sub) => {
      capturedEvents = sub.events ?? {};
      return unsubscribe;
    });
    mockFetchChatRooms.mockResolvedValue({ rooms: [] });
    mockFetchChatRoomMembers.mockResolvedValue({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValue({ messages: [] });
    mockCreateChatRoom.mockResolvedValue({ room: room("room-new", "new", "2026-05-09T01:00:00.000Z") });
    mockDeleteChatRoom.mockResolvedValue({ success: true });
    mockPostChatRoomMessage.mockResolvedValue({ message: roomMessage("msg-posted", "room-new", "posted") });
  });

  it("loads rooms on mount", async () => {
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [room("room-1", "one", "2026-05-09T01:00:00.000Z")] });
    const { result } = renderHook(() => useChatRooms("proj-1"));

    await waitFor(() => expect(result.current.roomsLoading).toBe(false));
    expect(result.current.rooms).toHaveLength(1);
    expect(mockFetchChatRooms).toHaveBeenCalledWith({}, "proj-1");
  });

  it("createRoom persists and loads active room members/messages", async () => {
    const { result } = renderHook(() => useChatRooms("proj-1"));
    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [roomMember("room-new", "agent-1")] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [roomMessage("msg-1", "room-new", "hello")] });

    await waitFor(() => expect(result.current.roomsLoading).toBe(false));

    await act(async () => {
      await result.current.createRoom({ name: "new", memberAgentIds: ["agent-1"] });
    });

    expect(mockCreateChatRoom).toHaveBeenCalledWith({ name: "new", memberAgentIds: ["agent-1"] }, "proj-1");
    expect(result.current.activeRoom?.id).toBe("room-new");
    expect(result.current.activeRoomMembers).toHaveLength(1);
    expect(result.current.messages).toHaveLength(1);
  });

  it("selectRoom loads messages and clears previous messages", async () => {
    const first = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    const second = room("room-2", "two", "2026-05-09T02:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [first, second] });
    const { result } = renderHook(() => useChatRooms("proj-1"));

    await waitFor(() => expect(result.current.rooms.length).toBe(2));
    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [roomMember("room-1", "agent-1")] });
    mockFetchChatRoomMessages.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ messages: [roomMessage("msg-1", "room-1", "first")] }), 20)),
    );

    act(() => {
      result.current.selectRoom("room-1");
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [roomMember("room-2", "agent-2")] });
    mockFetchChatRoomMessages.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ messages: [roomMessage("msg-2", "room-2", "second")] }), 20)),
    );

    act(() => {
      result.current.selectRoom("room-2");
    });

    expect(result.current.messages).toEqual([]);
    await waitFor(() => expect(result.current.messages[0]?.id).toBe("msg-2"));
  });

  it("handles room message SSE for active and inactive rooms", async () => {
    const older = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    const newer = room("room-2", "two", "2026-05-09T02:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [older, newer] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(2));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-2"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-2"));

    act(() => {
      capturedEvents["chat:room:message:added"]?.({ data: JSON.stringify(roomMessage("msg-a", "room-2", "active")) } as MessageEvent);
    });
    expect(result.current.messages.map((message) => message.id)).toContain("msg-a");

    act(() => {
      capturedEvents["chat:room:message:added"]?.({ data: JSON.stringify(roomMessage("msg-b", "room-1", "inactive", "2026-05-09T03:00:00.000Z")) } as MessageEvent);
    });
    expect(result.current.rooms[0]?.id).toBe("room-1");
  });

  it("clears active room when active room is deleted via SSE", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    act(() => {
      capturedEvents["chat:room:deleted"]?.({ data: JSON.stringify({ id: "room-1" }) } as MessageEvent);
    });

    expect(result.current.activeRoom).toBeNull();
  });

  it("loads newest 100 room messages using desc fetch while preserving ascending transcript", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    const newestWindow = Array.from({ length: 100 }, (_, index) => {
      const sequence = index + 8;
      return roomMessage(`msg-${sequence}`, "room-1", `message-${sequence}`);
    });

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: newestWindow });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    expect(mockFetchChatRoomMessages).toHaveBeenLastCalledWith("room-1", { limit: 100, order: "desc" }, "proj-1");
    expect(result.current.messages.at(-1)?.id).toBe("msg-107");
    expect(result.current.messages.some((message) => message.id === "msg-1")).toBe(false);
  });

  it("sendRoomMessage inserts optimistic temp message and reconciles to server transcript", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    let resolvePost: ((value: { message: ChatRoomMessage }) => void) | undefined;
    const postPromise = new Promise<{ message: ChatRoomMessage }>((resolve) => {
      resolvePost = resolve;
    });
    mockPostChatRoomMessage.mockReturnValueOnce(postPromise);

    mockFetchChatRoomMessages.mockResolvedValueOnce({
      messages: [
        roomMessage("msg-user", "room-1", "hello"),
        { ...roomMessage("msg-assistant", "room-1", "Room reply"), role: "assistant", senderAgentId: "agent-1" },
      ],
    });

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendRoomMessage("hello");
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]?.id.startsWith("temp-")).toBe(true);
    expect(result.current.messages[0]?.content).toBe("hello");

    resolvePost?.({ message: roomMessage("msg-user", "room-1", "hello") });

    await act(async () => {
      await sendPromise;
    });

    expect(mockPostChatRoomMessage).toHaveBeenCalledWith("room-1", { content: "hello" }, "proj-1");
    expect(mockFetchChatRoomMessages).toHaveBeenLastCalledWith("room-1", { limit: 100, order: "desc" }, "proj-1");
    expect(result.current.messages.map((message) => message.id)).toEqual(["msg-user", "msg-assistant"]);
  });

  it("rolls back optimistic temp message when post fails and transcript refresh fails", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    mockPostChatRoomMessage.mockRejectedValueOnce(new Error("POST failed"));
    mockFetchChatRoomMessages.mockRejectedValueOnce(new Error("refresh failed"));

    await act(async () => {
      await expect(result.current.sendRoomMessage("hello")).rejects.toThrow("POST failed");
    });

    expect(result.current.messages).toEqual([]);
  });

  it("uses desc order when refreshing after send failure", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    mockPostChatRoomMessage.mockRejectedValueOnce(new Error("No active room responders available for room room-1"));
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [roomMessage("msg-user", "room-1", "hello")] });

    await act(async () => {
      await expect(result.current.sendRoomMessage("hello")).rejects.toThrow("No active room responders available for room room-1");
    });

    expect(mockFetchChatRoomMessages).toHaveBeenLastCalledWith("room-1", { limit: 100, order: "desc" }, "proj-1");
  });

  it("refreshes persisted room messages even when room reply generation fails", async () => {    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    const persistedUserMessage = roomMessage("msg-user", "room-1", "hello");
    mockPostChatRoomMessage.mockRejectedValueOnce(new Error("No active room responders available for room room-1"));
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [persistedUserMessage] });

    const sendPromise = act(async () => {
      await expect(result.current.sendRoomMessage("hello")).rejects.toThrow("No active room responders available for room room-1");
    });
    await sendPromise;
    await waitFor(() => {
      expect(result.current.messages.map((message) => message.id)).toEqual(["msg-user"]);
    });
  });

  it("tears down sse subscription on unmount", async () => {
    const { unmount } = renderHook(() => useChatRooms("proj-1"));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

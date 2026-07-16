import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRoom, ChatRoomMember, ChatRoomMessage } from "@fusion/core";
import { RoomMessageDeliveredButReplyFailedError, useChatRooms } from "../useChatRooms";
import * as apiModule from "../../api";
import * as sseBusModule from "../../sse-bus";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";

vi.mock("../../api", () => ({
  fetchChatRooms: vi.fn(),
  createChatRoom: vi.fn(),
  fetchChatRoomMembers: vi.fn(),
  fetchChatRoomMessages: vi.fn(),
  deleteChatRoom: vi.fn(),
  postChatRoomMessage: vi.fn(),
  updateChatRoom: vi.fn(),
  uploadChatRoomAttachment: vi.fn(),
  clearChatRoomMessages: vi.fn(),
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
const mockUpdateChatRoom = vi.mocked(apiModule.updateChatRoom);
const mockUploadChatRoomAttachment = vi.mocked(apiModule.uploadChatRoomAttachment);
const mockClearChatRoomMessages = vi.mocked(apiModule.clearChatRoomMessages);
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
    thinkingLevel: null,
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
    window.localStorage.clear();
    mockFetchChatRooms.mockResolvedValue({ rooms: [] });
    mockFetchChatRoomMembers.mockResolvedValue({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValue({ messages: [] });
    mockCreateChatRoom.mockResolvedValue({ room: room("room-new", "new", "2026-05-09T01:00:00.000Z") });
    mockDeleteChatRoom.mockResolvedValue({ success: true });
    mockPostChatRoomMessage.mockResolvedValue({ message: roomMessage("msg-posted", "room-new", "posted") });
    mockUpdateChatRoom.mockResolvedValue({ room: { ...room("room-new", "new", "2026-05-09T02:00:00.000Z"), thinkingLevel: "high" } });
    mockUploadChatRoomAttachment.mockResolvedValue({
      attachment: {
        id: "att-uploaded",
        filename: "upload.png",
        originalName: "upload.png",
        mimeType: "image/png",
        size: 4,
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    });
    mockClearChatRoomMessages.mockResolvedValue({ success: true, deletedCount: 1 });
  });

  it("hydrates cached rooms and active room synchronously", async () => {
    const cachedRooms = [room("room-1", "one", "2026-05-09T01:00:00.000Z")];
    window.localStorage.setItem(
      `${SWR_CACHE_KEYS.CHAT_ROOMS}:proj-1`,
      JSON.stringify({ savedAt: Date.now(), data: cachedRooms }),
    );
    window.localStorage.setItem(
      `${SWR_CACHE_KEYS.ACTIVE_CHAT_ROOM_ID}:proj-1`,
      JSON.stringify({ savedAt: Date.now(), data: "room-1" }),
    );
    mockFetchChatRooms.mockImplementationOnce(
      () =>
        new Promise(() => {
          // keep pending; assert fast-path hydration
        }),
    );

    const { result } = renderHook(() => useChatRooms("proj-1"));

    expect(result.current.rooms).toEqual(cachedRooms);
    expect(result.current.activeRoom?.id).toBe("room-1");
    expect(result.current.roomsLoading).toBe(false);
  });

  it("loads rooms on mount", async () => {    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [room("room-1", "one", "2026-05-09T01:00:00.000Z")] });
    const { result } = renderHook(() => useChatRooms("proj-1"));

    await waitFor(() => expect(result.current.roomsLoading).toBe(false));
    expect(result.current.rooms).toHaveLength(1);
    expect(mockFetchChatRooms).toHaveBeenCalledWith({}, "proj-1");
  });

  it("writes rooms list to cache after successful refresh", async () => {
    const rooms = [room("room-1", "one", "2026-05-09T01:00:00.000Z")];
    mockFetchChatRooms.mockResolvedValueOnce({ rooms });

    renderHook(() => useChatRooms("proj-1"));

    await waitFor(() => {
      const envelope = JSON.parse(window.localStorage.getItem(`${SWR_CACHE_KEYS.CHAT_ROOMS}:proj-1`) ?? "{}");
      expect(envelope).toMatchObject({ savedAt: expect.any(Number) });
      expect(envelope.data).toEqual(rooms);
    });
  });

  it("createRoom persists and loads active room members/messages", async () => {    const { result } = renderHook(() => useChatRooms("proj-1"));
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

  it("updateRoomSettings upserts returned room and refreshes active room thinkingLevel", async () => {
    const existing = room("room-new", "new", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [existing] });
    const { result } = renderHook(() => useChatRooms("proj-1"));

    await waitFor(() => expect(result.current.rooms).toHaveLength(1));
    act(() => result.current.selectRoom("room-new"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-new"));

    await act(async () => {
      await result.current.updateRoomSettings("room-new", { thinkingLevel: "high" });
    });

    expect(mockUpdateChatRoom).toHaveBeenCalledWith("room-new", { thinkingLevel: "high" }, "proj-1");
    expect(result.current.activeRoom?.thinkingLevel).toBe("high");
    expect(result.current.rooms.find((candidate) => candidate.id === "room-new")?.thinkingLevel).toBe("high");
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

  it("keeps messages out of cache payload", async () => {
    const rooms = [room("room-1", "one", "2026-05-09T01:00:00.000Z")];
    mockFetchChatRooms.mockResolvedValueOnce({ rooms });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.roomsLoading).toBe(false));

    const envelope = JSON.parse(window.localStorage.getItem(`${SWR_CACHE_KEYS.CHAT_ROOMS}:proj-1`) ?? "{}");
    expect(envelope).toMatchObject({ savedAt: expect.any(Number) });
    const cached = envelope.data as Array<Record<string, unknown>>;
    expect(cached?.[0]).not.toHaveProperty("messages");
  });

  it("normalizes descending initial room hydration to chronological state", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    const descendingTranscript = [
      { ...roomMessage("assistant-pm", "room-1", "PM reply", "2026-05-09T00:02:01.000Z"), role: "assistant" as const, senderAgentId: "pm" },
      { ...roomMessage("assistant-cto", "room-1", "CTO reply", "2026-05-09T00:02:00.000Z"), role: "assistant" as const, senderAgentId: "cto" },
      roomMessage("user-hi", "room-1", "Hi", "2026-05-09T00:00:00.000Z"),
    ];
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: descendingTranscript });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms).toHaveLength(1));

    act(() => result.current.selectRoom("room-1"));

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.id)).toEqual(["user-hi", "assistant-cto", "assistant-pm"]);
    });
  });

  it("normalizes the descending authoritative post-send refresh and appends optimistic messages", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    const descendingTranscript = [
      { ...roomMessage("assistant-reply", "room-1", "Reply", "2026-05-09T00:03:00.000Z"), role: "assistant" as const, senderAgentId: "agent-1" },
      roomMessage("posted-user", "room-1", "Hi", "2026-05-09T00:02:00.000Z"),
      roomMessage("older-user", "room-1", "Earlier", "2026-05-09T00:00:00.000Z"),
    ];
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms).toHaveLength(1));
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    let resolvePost!: (value: { message: ChatRoomMessage }) => void;
    mockPostChatRoomMessage.mockReturnValueOnce(new Promise((resolve) => { resolvePost = resolve; }));
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: descendingTranscript });
    let sendPromise!: Promise<void>;
    await act(async () => { sendPromise = result.current.sendRoomMessage("Hi"); });
    expect(result.current.messages.at(-1)?.content).toBe("Hi");

    resolvePost({ message: descendingTranscript[1]! });
    await act(async () => { await sendPromise; });
    expect(result.current.messages.map((message) => message.id)).toEqual(["older-user", "posted-user", "assistant-reply"]);
  });

  it("normalizes the descending recovery refresh and appends SSE messages at the bottom", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    const descendingTranscript = [
      { ...roomMessage("assistant-reply", "room-1", "Reply", "2026-05-09T00:03:00.000Z"), role: "assistant" as const, senderAgentId: "agent-1" },
      roomMessage("recovered-user", "room-1", "Hi", "2026-05-09T00:02:00.000Z"),
      roomMessage("older-user", "room-1", "Earlier", "2026-05-09T00:00:00.000Z"),
    ];
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms).toHaveLength(1));
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    mockPostChatRoomMessage.mockRejectedValueOnce(new Error("post failed"));
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: descendingTranscript });
    await act(async () => { await expect(result.current.sendRoomMessage("Hi")).rejects.toThrow("post failed"); });
    expect(result.current.messages.map((message) => message.id)).toEqual(["older-user", "recovered-user", "assistant-reply"]);

    const sseMessage = { ...roomMessage("sse-new", "room-1", "Newest", "2026-05-09T00:04:00.000Z"), role: "assistant" as const, senderAgentId: "agent-2" };
    act(() => {
      capturedEvents["chat:room:message:added"]?.({ data: JSON.stringify(sseMessage) } as MessageEvent);
    });
    expect(result.current.messages.at(-1)?.id).toBe("sse-new");
  });

  it("handles room message SSE for active and inactive rooms", async () => {    const older = room("room-1", "one", "2026-05-09T01:00:00.000Z");
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
    expect(result.current.messages.map((message) => message.id)).toEqual(["msg-assistant", "msg-user"]);
  });

  it("deduplicates user message across optimistic add, SSE echo, and post resolution interleaving", async () => {
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
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [roomMessage("msg-user", "room-1", "hello")] });

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendRoomMessage("hello");
    });

    act(() => {
      capturedEvents["chat:room:message:added"]?.({ data: JSON.stringify(roomMessage("msg-user", "room-1", "hello")) } as MessageEvent);
    });

    resolvePost?.({ message: roomMessage("msg-user", "room-1", "hello") });

    await act(async () => {
      await sendPromise;
    });

    const matchingMessages = result.current.messages.filter((message) => message.role === "user" && message.content === "hello");
    expect(matchingMessages).toHaveLength(1);
    expect(matchingMessages[0]?.id).toBe("msg-user");
  });

  it("uploads files before posting room message", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    const file = new File(["png"], "upload.png", { type: "image/png" });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [roomMessage("msg-user", "room-1", "hello")] });

    await act(async () => {
      await result.current.sendRoomMessage("hello", { files: [file] });
    });

    expect(mockUploadChatRoomAttachment).toHaveBeenCalledWith("room-1", file, "proj-1");
    expect(mockPostChatRoomMessage).toHaveBeenCalledWith("room-1", {
      content: "hello",
      attachments: [expect.objectContaining({ id: "att-uploaded", filename: "upload.png" })],
    }, "proj-1");
  });

  it("throws on upload failure and does not post", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    const file = new File(["x"], "bad.txt", { type: "text/plain" });
    mockUploadChatRoomAttachment.mockRejectedValueOnce(new Error("Upload failed"));
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });

    let uploadError: unknown;
    await act(async () => {
      try {
        await result.current.sendRoomMessage("hello", { files: [file] });
      } catch (error) {
        uploadError = error;
      }
    });

    expect(uploadError).toBeInstanceOf(Error);
    expect((uploadError as Error).message).toBe("Failed to upload attachment: bad.txt");
    expect(uploadError).not.toBeInstanceOf(RoomMessageDeliveredButReplyFailedError);

    expect(mockPostChatRoomMessage).not.toHaveBeenCalledWith("room-1", expect.objectContaining({ content: "hello" }), "proj-1");
  });

  it("rejects with original error while preserving recovered replies when post fails without a persisted user message", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    const recoveredAssistantReply = {
      ...roomMessage("msg-assistant", "room-1", "Room reply"),
      role: "assistant" as const,
      senderAgentId: "agent-1",
    };
    mockPostChatRoomMessage.mockRejectedValueOnce(new Error("POST failed"));
    mockFetchChatRoomMessages.mockResolvedValueOnce({
      messages: [recoveredAssistantReply],
    });

    let postError: unknown;
    await act(async () => {
      try {
        await result.current.sendRoomMessage("hello");
      } catch (error) {
        postError = error;
      }
    });

    expect(postError).toBeInstanceOf(Error);
    expect((postError as Error).message).toBe("POST failed");
    expect(postError).not.toBeInstanceOf(RoomMessageDeliveredButReplyFailedError);

    expect(result.current.messages).toEqual([recoveredAssistantReply]);
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

  it("wraps post-delivery refresh failures with RoomMessageDeliveredButReplyFailedError", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    mockPostChatRoomMessage.mockResolvedValueOnce({ message: roomMessage("msg-user", "room-1", "hello") });
    mockFetchChatRoomMessages
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce({ messages: [roomMessage("msg-user", "room-1", "hello")] });

    let deliveryError: unknown;
    await act(async () => {
      try {
        await result.current.sendRoomMessage("hello");
      } catch (error) {
        deliveryError = error;
      }
    });

    expect(deliveryError).toBeInstanceOf(RoomMessageDeliveredButReplyFailedError);
    expect(deliveryError).toEqual(
      expect.objectContaining({
        name: "RoomMessageDeliveredButReplyFailedError",
        roomId: "room-1",
        message: "refresh failed",
      }),
    );
  });

  it("keeps delivered optimistic room message visible when reply and recovery refresh fail", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-1"));

    mockPostChatRoomMessage.mockResolvedValueOnce({ message: roomMessage("msg-user", "room-1", "hello after 429") });
    mockFetchChatRoomMessages
      .mockRejectedValueOnce(new Error("provider reply failed"))
      .mockRejectedValueOnce(new Error("recovery failed"));

    await act(async () => {
      await expect(result.current.sendRoomMessage("hello after 429")).rejects.toBeInstanceOf(RoomMessageDeliveredButReplyFailedError);
    });

    const matchingMessages = result.current.messages.filter((message) => message.role === "user" && message.content === "hello after 429");
    expect(matchingMessages).toHaveLength(1);
    expect(matchingMessages[0]?.id).toBe("msg-user");
  });

  it("classifies post rejection as delivered when recovery transcript includes persisted user message", async () => {    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
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
      await expect(result.current.sendRoomMessage("hello")).rejects.toBeInstanceOf(RoomMessageDeliveredButReplyFailedError);
    });
    await sendPromise;
    await waitFor(() => {
      expect(result.current.messages.map((message) => message.id)).toEqual(["msg-user"]);
    });
  });

  it("clearRoom empties messages for active room", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [roomMessage("msg-1", "room-1", "hello")] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    await act(async () => {
      await result.current.clearRoom("room-1");
    });

    expect(mockClearChatRoomMessages).toHaveBeenCalledWith("room-1", "proj-1");
    expect(result.current.messages).toEqual([]);
  });

  it("clearRoom does not mutate messages when another room is active", async () => {
    const first = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    const second = room("room-2", "two", "2026-05-09T02:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [first, second] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(2));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [roomMessage("msg-2", "room-2", "hello")] });
    act(() => result.current.selectRoom("room-2"));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    await act(async () => {
      await result.current.clearRoom("room-1");
    });

    expect(result.current.messages).toHaveLength(1);
  });

  it("SSE clear event empties messages for active room", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [roomMessage("msg-1", "room-1", "hello")] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    act(() => {
      capturedEvents["chat:room:messages:cleared"]?.({ data: JSON.stringify({ roomId: "room-1", deletedCount: 3 }) } as MessageEvent);
    });

    expect(result.current.messages).toEqual([]);
  });

  it("clearRoom rethrows API failure and preserves messages", async () => {
    const active = room("room-1", "one", "2026-05-09T01:00:00.000Z");
    mockFetchChatRooms.mockResolvedValueOnce({ rooms: [active] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBe(1));

    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [roomMessage("msg-1", "room-1", "hello")] });
    act(() => result.current.selectRoom("room-1"));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    mockClearChatRoomMessages.mockRejectedValueOnce(new Error("clear failed"));

    await act(async () => {
      await expect(result.current.clearRoom("room-1")).rejects.toThrow("clear failed");
    });

    expect(result.current.messages).toHaveLength(1);
  });

  it("tears down sse subscription on unmount", async () => {
    const { unmount } = renderHook(() => useChatRooms("proj-1"));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

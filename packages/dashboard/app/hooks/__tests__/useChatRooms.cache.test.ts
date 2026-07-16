import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRoom, ChatRoomMember, ChatRoomMessage } from "@fusion/core";
import { useChatRooms } from "../useChatRooms";
import * as apiModule from "../../api";
import * as sseBusModule from "../../sse-bus";
import { readCache, SWR_CACHE_KEYS, writeCache } from "../../utils/swrCache";

vi.mock("../../api", () => ({
  fetchChatRooms: vi.fn(),
  createChatRoom: vi.fn(),
  fetchChatRoomMembers: vi.fn(),
  fetchChatRoomMessages: vi.fn(),
  deleteChatRoom: vi.fn(),
  postChatRoomMessage: vi.fn(),
  uploadChatRoomAttachment: vi.fn(),
  clearChatRoomMessages: vi.fn(),
}));

vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));
vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(() => null),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
}));

const mockFetchChatRooms = vi.mocked(apiModule.fetchChatRooms);
const mockFetchChatRoomMembers = vi.mocked(apiModule.fetchChatRoomMembers);
const mockFetchChatRoomMessages = vi.mocked(apiModule.fetchChatRoomMessages);
const mockSubscribeSse = vi.mocked(sseBusModule.subscribeSse);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function room(id: string, updatedAt: string): ChatRoom {
  return { id, name: id, slug: id, description: null, projectId: "proj-1", createdBy: null, status: "active", createdAt: updatedAt, updatedAt };
}
function member(roomId: string, agentId: string): ChatRoomMember {
  return { roomId, agentId, role: "member", addedAt: "2026-05-20T00:00:00.000Z" };
}
function message(id: string, roomId: string, content: string): ChatRoomMessage {
  return { id, roomId, role: "user", content, thinkingOutput: null, metadata: null, senderAgentId: null, mentions: [], createdAt: `2026-05-20T00:00:0${id.slice(-1)}.000Z` };
}

describe("useChatRooms cache behavior", () => {
  let events: Record<string, (event: MessageEvent) => void> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    events = {};
    mockSubscribeSse.mockImplementation((_url, sub) => {
      events = sub.events ?? {};
      return () => {};
    });
    mockFetchChatRooms.mockResolvedValue({ rooms: [room("room-a", "2026-05-20T00:00:00.000Z"), room("room-b", "2026-05-20T00:00:01.000Z")] });
    mockFetchChatRoomMembers.mockResolvedValue({ members: [] });
    mockFetchChatRoomMessages.mockResolvedValue({ messages: [] });
  });

  it("warm open paints cached data before network resolves", async () => {
    const cachedMessages = [message("m2", "room-a", "cached")];
    const cachedMembers = [member("room-a", "agent-1")];
    writeCache(`${SWR_CACHE_KEYS.CHAT_ROOM_MESSAGES_PREFIX}proj-1:room-a`, cachedMessages, { maxBytes: 500_000 });
    writeCache(`${SWR_CACHE_KEYS.CHAT_ROOM_MEMBERS_PREFIX}proj-1:room-a`, cachedMembers, { maxBytes: 500_000 });

    const membersDef = deferred<{ members: ChatRoomMember[] }>();
    const messagesDef = deferred<{ messages: ChatRoomMessage[] }>();
    mockFetchChatRoomMembers.mockReturnValueOnce(membersDef.promise);
    mockFetchChatRoomMessages.mockReturnValueOnce(messagesDef.promise);

    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBeGreaterThan(0));

    act(() => result.current.selectRoom("room-a"));

    expect(result.current.messages).toEqual(cachedMessages);
    expect(result.current.activeRoomMembers).toEqual(cachedMembers);
    expect(result.current.messagesLoading).toBe(false);

    await act(async () => {
      membersDef.resolve({ members: [member("room-a", "agent-2")] });
      messagesDef.resolve({ messages: [message("m9", "room-a", "fresh")] });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.messages[0]?.id).toBe("m9"));
  });

  it("cold open keeps loading true until fetch resolves", async () => {
    const messagesDef = deferred<{ messages: ChatRoomMessage[] }>();
    mockFetchChatRoomMessages.mockReturnValueOnce(messagesDef.promise);
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBeGreaterThan(0));

    act(() => result.current.selectRoom("room-a"));
    expect(result.current.messagesLoading).toBe(true);

    await act(async () => {
      messagesDef.resolve({ messages: [message("m3", "room-a", "cold")] });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages[0]?.id).toBe("m3");
  });

  it("stale-room guard prevents room A fetch from overwriting room B", async () => {
    const aDef = deferred<{ messages: ChatRoomMessage[] }>();
    const bDef = deferred<{ messages: ChatRoomMessage[] }>();
    mockFetchChatRoomMessages.mockReturnValueOnce(aDef.promise).mockReturnValueOnce(bDef.promise);

    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBeGreaterThan(1));

    act(() => result.current.selectRoom("room-a"));
    act(() => result.current.selectRoom("room-b"));

    await act(async () => {
      aDef.resolve({ messages: [message("m1", "room-a", "a") ] });
      bDef.resolve({ messages: [message("m2", "room-b", "b") ] });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-b"));
    expect(result.current.messages[0]?.roomId).toBe("room-b");
  });

  it("SSE message add writes an ascending cache snapshot", async () => {
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [message("m2", "room-a", "newer"), message("m1", "room-a", "older")] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBeGreaterThan(0));

    act(() => result.current.selectRoom("room-a"));
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2"]));

    act(() => {
      events["chat:room:message:added"]?.({ data: JSON.stringify(message("m3", "room-a", "latest")) } as MessageEvent);
    });

    const cached = readCache<ChatRoomMessage[]>(`${SWR_CACHE_KEYS.CHAT_ROOM_MESSAGES_PREFIX}proj-1:room-a`);
    expect(cached?.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("refreshRooms uses persisted room id and warm cache", async () => {
    writeCache(`${SWR_CACHE_KEYS.ACTIVE_CHAT_ROOM_ID}:proj-1`, "room-a", { maxBytes: 500_000 });
    writeCache(`${SWR_CACHE_KEYS.CHAT_ROOM_MESSAGES_PREFIX}proj-1:room-a`, [message("m8", "room-a", "cached")], { maxBytes: 500_000 });

    const messagesDef = deferred<{ messages: ChatRoomMessage[] }>();
    mockFetchChatRoomMessages.mockReturnValueOnce(messagesDef.promise);

    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.activeRoom?.id).toBe("room-a"));
    expect(result.current.messages.map((m) => m.id)).toEqual(["m8"]);
    expect(result.current.messagesLoading).toBe(false);

    await act(async () => {
      messagesDef.resolve({ messages: [message("m9", "room-a", "fresh")] });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.messages[0]?.id).toBe("m9"));
  });

  it("SSE member add/remove updates members cache", async () => {
    mockFetchChatRoomMembers.mockResolvedValueOnce({ members: [member("room-a", "agent-1")] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBeGreaterThan(0));
    act(() => result.current.selectRoom("room-a"));
    await waitFor(() => expect(result.current.activeRoomMembers.map((m) => m.agentId)).toEqual(["agent-1"]));

    act(() => {
      events["chat:room:member:added"]?.({ data: JSON.stringify(member("room-a", "agent-2")) } as MessageEvent);
    });
    expect(readCache<ChatRoomMember[]>(`${SWR_CACHE_KEYS.CHAT_ROOM_MEMBERS_PREFIX}proj-1:room-a`)?.map((m) => m.agentId)).toEqual(["agent-1", "agent-2"]);

    act(() => {
      events["chat:room:member:removed"]?.({ data: JSON.stringify({ roomId: "room-a", agentId: "agent-1" }) } as MessageEvent);
    });
    expect(readCache<ChatRoomMember[]>(`${SWR_CACHE_KEYS.CHAT_ROOM_MEMBERS_PREFIX}proj-1:room-a`)?.map((m) => m.agentId)).toEqual(["agent-2"]);
  });

  it("SSE message delete and clear update message cache", async () => {
    mockFetchChatRoomMessages.mockResolvedValueOnce({ messages: [message("m2", "room-a", "newer"), message("m1", "room-a", "older")] });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBeGreaterThan(0));
    act(() => result.current.selectRoom("room-a"));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    act(() => {
      events["chat:room:message:deleted"]?.({ data: JSON.stringify({ id: "m1" }) } as MessageEvent);
    });
    expect(readCache<ChatRoomMessage[]>(`${SWR_CACHE_KEYS.CHAT_ROOM_MESSAGES_PREFIX}proj-1:room-a`)?.map((m) => m.id)).toEqual(["m2"]);

    act(() => {
      events["chat:room:messages:cleared"]?.({ data: JSON.stringify({ roomId: "room-a", deletedCount: 1 }) } as MessageEvent);
    });
    expect(readCache<ChatRoomMessage[]>(`${SWR_CACHE_KEYS.CHAT_ROOM_MESSAGES_PREFIX}proj-1:room-a`)).toEqual([]);
  });

  it("clearRoom invalidates room message cache", async () => {
    writeCache(`${SWR_CACHE_KEYS.CHAT_ROOM_MESSAGES_PREFIX}proj-1:room-a`, [message("m1", "room-a", "x")], { maxBytes: 500_000 });
    const { result } = renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(result.current.rooms.length).toBeGreaterThan(0));

    await act(async () => {
      await result.current.clearRoom("room-a");
    });

    expect(readCache(`${SWR_CACHE_KEYS.CHAT_ROOM_MESSAGES_PREFIX}proj-1:room-a`)).toEqual([]);
  });

  it("room deleted invalidates room caches", async () => {
    writeCache(`${SWR_CACHE_KEYS.CHAT_ROOM_MESSAGES_PREFIX}proj-1:room-a`, [message("m1", "room-a", "x")], { maxBytes: 500_000 });
    writeCache(`${SWR_CACHE_KEYS.CHAT_ROOM_MEMBERS_PREFIX}proj-1:room-a`, [member("room-a", "agent-1")], { maxBytes: 500_000 });

    renderHook(() => useChatRooms("proj-1"));
    await waitFor(() => expect(mockSubscribeSse).toHaveBeenCalled());

    act(() => {
      events["chat:room:deleted"]?.({ data: JSON.stringify({ id: "room-a" }) } as MessageEvent);
    });

    expect(readCache(`${SWR_CACHE_KEYS.CHAT_ROOM_MESSAGES_PREFIX}proj-1:room-a`)).toEqual([]);
    expect(readCache(`${SWR_CACHE_KEYS.CHAT_ROOM_MEMBERS_PREFIX}proj-1:room-a`)).toEqual([]);
  });
});

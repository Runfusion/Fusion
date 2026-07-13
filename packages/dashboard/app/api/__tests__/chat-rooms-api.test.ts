import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addChatRoomMember,
  createChatRoom,
  deleteChatRoom,
  clearChatRoomMessages,
  deleteChatRoomMessage,
  fetchChatRoom,
  fetchChatRoomMembers,
  fetchChatRoomMessages,
  fetchChatRooms,
  postChatRoomMessage,
  removeChatRoomMember,
  updateChatRoom,
} from "../legacy";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

describe("chat room legacy API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds request for fetchChatRooms", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ rooms: [] }));
    await fetchChatRooms({ status: "active", agentId: "agent-1" }, "proj-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/chat/rooms?");
    expect(url).toContain("projectId=proj-1");
    expect(url).toContain("status=active");
    expect(url).toContain("agentId=agent-1");
    expect(init.method).toBeUndefined();
  });

  it("builds CRUD room endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ success: true }));

    await fetchChatRoom("room-1", "proj-1");
    await createChatRoom({ name: "Engineering", thinkingLevel: "high" }, "proj-1");
    await updateChatRoom("room-1", { description: "desc", thinkingLevel: null }, "proj-1");
    await deleteChatRoom("room-1", "proj-1");

    expect((fetchMock.mock.calls[0] as [string])[0]).toContain("/api/chat/rooms/room-1?projectId=proj-1");

    const [, createInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(createInit.method).toBe("POST");
    expect(createInit.body).toBe(JSON.stringify({ name: "Engineering", thinkingLevel: "high", projectId: "proj-1" }));

    const [, updateInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(updateInit.method).toBe("PATCH");
    expect(updateInit.body).toBe(JSON.stringify({ description: "desc", thinkingLevel: null }));

    const [, deleteInit] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(deleteInit.method).toBe("DELETE");
  });

  it("builds member endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ success: true }));

    await fetchChatRoomMembers("room-1", "proj-2");
    await addChatRoomMember("room-1", { agentId: "agent-2", role: "owner" }, "proj-2");
    await removeChatRoomMember("room-1", "agent-2", "proj-2");

    expect((fetchMock.mock.calls[0] as [string])[0]).toContain("/api/chat/rooms/room-1/members?projectId=proj-2");
    const [, addInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(addInit.method).toBe("POST");
    expect(addInit.body).toBe(JSON.stringify({ agentId: "agent-2", role: "owner" }));
    expect((fetchMock.mock.calls[2] as [string])[0]).toContain("/api/chat/rooms/room-1/members/agent-2?projectId=proj-2");
  });

  it("builds message endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ success: true }));

    await fetchChatRoomMessages("room-1", { limit: 2, offset: 1, before: "2026-01-01", order: "desc" }, "proj-3");
    await postChatRoomMessage("room-1", { content: "hello", mentions: ["agent-x"] }, "proj-3");
    await deleteChatRoomMessage("room-1", "msg-1", "proj-3");
    await clearChatRoomMessages("room-1", "proj-3");

    const [listUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(listUrl).toContain("/api/chat/rooms/room-1/messages?");
    expect(listUrl).toContain("projectId=proj-3");
    expect(listUrl).toContain("limit=2");
    expect(listUrl).toContain("offset=1");
    expect(listUrl).toContain("before=2026-01-01");
    expect(listUrl).toContain("order=desc");

    const [, postInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(postInit.method).toBe("POST");
    expect(postInit.body).toBe(JSON.stringify({ content: "hello", mentions: ["agent-x"] }));

    const [, delInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(delInit.method).toBe("DELETE");

    const [clearUrl, clearInit] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(clearUrl).toContain("/api/chat/rooms/room-1/messages?projectId=proj-3");
    expect(clearInit.method).toBe("DELETE");
  });

  it("omits order param when undefined", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ messages: [] }));

    await fetchChatRoomMessages("room-1", { limit: 2 }, "proj-3");

    const [listUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(listUrl).toContain("limit=2");
    expect(listUrl).not.toContain("order=");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatManager, __setCreateResolvedAgentSession, __resetChatState } from "../chat.js";

const mockChatStore = {
  listRoomMembers: vi.fn(),
  createSession: vi.fn(),
  getRoom: vi.fn(),
  addRoomMessage: vi.fn(),
};

const mockAgentStore = {
  init: vi.fn(),
  listAgents: vi.fn(),
};

describe("ChatManager room hybrid responder resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatState();
    mockChatStore.getRoom.mockReturnValue({ id: "room-1", name: "room-1" });
    mockChatStore.addRoomMessage.mockImplementation((_roomId: string, input: any) => ({
      id: `msg-${mockChatStore.addRoomMessage.mock.calls.length}`,
      roomId: "room-1",
      ...input,
    }));
  });

  it("returns ambient members when there are no mentions", () => {
    mockChatStore.listRoomMembers.mockReturnValue([
      { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      { roomId: "room-1", agentId: "agent-b", role: "member", addedAt: "2026-01-01" },
    ]);

    const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
    const result = (manager as any).resolveRoomResponders(
      { id: "chat-1", kind: "room", roomId: "room-1" },
      [],
      [
        { id: "agent-a", name: "A" },
        { id: "agent-b", name: "B" },
      ],
    );

    expect(result.direct).toEqual([]);
    expect(result.ambient.map((agent: any) => agent.id)).toEqual(["agent-a", "agent-b"]);
  });

  it("routes mentioned member to direct and others to ambient", () => {
    mockChatStore.listRoomMembers.mockReturnValue([
      { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      { roomId: "room-1", agentId: "agent-b", role: "member", addedAt: "2026-01-01" },
    ]);

    const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
    const result = (manager as any).resolveRoomResponders(
      { id: "chat-1", kind: "room", roomId: "room-1" },
      [{ agentId: "agent-b", agentName: "B" }],
      [
        { id: "agent-a", name: "A" },
        { id: "agent-b", name: "B" },
      ],
    );

    expect(result.direct.map((agent: any) => agent.id)).toEqual(["agent-b"]);
    expect(result.ambient.map((agent: any) => agent.id)).toEqual(["agent-a"]);
  });

  it("ignores non-member mentions for direct dispatch", () => {
    mockChatStore.listRoomMembers.mockReturnValue([
      { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
    ]);

    const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
    const result = (manager as any).resolveRoomResponders(
      { id: "chat-1", kind: "room", roomId: "room-1" },
      [{ agentId: "agent-z", agentName: "Z" }],
      [
        { id: "agent-a", name: "A" },
        { id: "agent-z", name: "Z" },
      ],
    );

    expect(result.direct).toEqual([]);
    expect(result.nonMemberMentions).toEqual([{ agentId: "agent-z", agentName: "Z" }]);
    expect(result.ambient.map((agent: any) => agent.id)).toEqual(["agent-a"]);
  });

  it("dedupes duplicate mentions", () => {
    mockChatStore.listRoomMembers.mockReturnValue([
      { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      { roomId: "room-1", agentId: "agent-b", role: "member", addedAt: "2026-01-01" },
    ]);

    const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
    const result = (manager as any).resolveRoomResponders(
      { id: "chat-1", kind: "room", roomId: "room-1" },
      [
        { agentId: "agent-b", agentName: "B" },
        { agentId: "agent-b", agentName: "B" },
      ],
      [
        { id: "agent-a", name: "A" },
        { id: "agent-b", name: "B" },
      ],
    );

    expect(result.direct.map((agent: any) => agent.id)).toEqual(["agent-b"]);
    expect(result.ambient.map((agent: any) => agent.id)).toEqual(["agent-a"]);
  });

  it("persists assistant room replies for resolved responders", async () => {
    mockChatStore.listRoomMembers.mockReturnValue([
      { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
    ]);
    mockAgentStore.listAgents.mockResolvedValue([{ id: "agent-a", name: "Alpha", role: "executor" }]);

    __setCreateResolvedAgentSession(async () => ({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
        state: {
          messages: [{ role: "assistant", content: "Room reply" }],
        },
      },
      provider: "test",
      model: "test",
      fallbackInfo: undefined,
    } as any));

    const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
    await manager.sendRoomMessage("room-1", "hello room");

    const assistantWrites = mockChatStore.addRoomMessage.mock.calls
      .map((call: any[]) => call[1])
      .filter((input: any) => input.role === "assistant");

    expect(assistantWrites).toHaveLength(1);
    expect(assistantWrites[0]).toMatchObject({
      role: "assistant",
      senderAgentId: "agent-a",
      content: "Room reply",
    });
  });
});

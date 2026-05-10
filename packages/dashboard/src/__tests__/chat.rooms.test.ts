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

describe("Chat orchestration — rooms (FN-3805..FN-3811 contract)", () => {
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

  describe("resolveRoomResponders", () => {
    it("partitions direct, ambient, and non-member mentions", () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
        { roomId: "room-1", agentId: "agent-b", role: "member", addedAt: "2026-01-01" },
      ]);

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
      const result = (manager as any).resolveRoomResponders(
        { id: "chat-1", kind: "room", roomId: "room-1" },
        [
          { agentId: "agent-b", agentName: "B" },
          { agentId: "agent-z", agentName: "Z" },
          { agentId: "agent-b", agentName: "B" },
        ],
        [
          { id: "agent-a", name: "A" },
          { id: "agent-b", name: "B" },
          { id: "agent-z", name: "Z" },
        ],
      );

      expect(result.direct.map((agent: any) => agent.id)).toEqual(["agent-b"]);
      expect(result.ambient.map((agent: any) => agent.id)).toEqual(["agent-a"]);
      expect(result.nonMemberMentions).toEqual([{ agentId: "agent-z", agentName: "Z" }]);
    });
  });

  describe("sendRoomMessage", () => {
    it("persists user and assistant messages for resolved responders", async () => {
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
      const result = await manager.sendRoomMessage("room-1", "hello @Alpha");

      expect(result.responders).toEqual(["agent-a"]);

      const userWrite = mockChatStore.addRoomMessage.mock.calls[0]?.[1];
      const assistantWrite = mockChatStore.addRoomMessage.mock.calls[1]?.[1];

      expect(userWrite).toMatchObject({ role: "user", content: "hello @Alpha", mentions: ["agent-a"] });
      expect(assistantWrite).toMatchObject({ role: "assistant", senderAgentId: "agent-a", content: "Room reply" });
    });

    it("records non-member mentions and emits explanatory assistant note", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([
        { id: "agent-a", name: "Alpha", role: "executor" },
        { id: "agent-z", name: "Zeta", role: "executor" },
      ]);

      __setCreateResolvedAgentSession(async () => ({
        session: {
          prompt: vi.fn(),
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Room reply" }],
          },
        },
      } as any));

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
      const result = await manager.sendRoomMessage("room-1", "hello @Alpha and @Zeta");

      expect(result.responders).toEqual(["agent-a"]);

      const writes = mockChatStore.addRoomMessage.mock.calls.map((call: any[]) => call[1]);
      expect(writes[0]).toMatchObject({
        role: "user",
        metadata: {
          nonMemberMentions: [{ agentId: "agent-z", agentName: "Zeta" }],
        },
      });
      expect(writes[writes.length - 1]).toMatchObject({
        role: "assistant",
        senderAgentId: null,
        content: expect.stringContaining("@Zeta"),
      });
    });
  });
});

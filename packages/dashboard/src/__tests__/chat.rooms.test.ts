import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatManager,
  ROOM_SKIP_SENTINEL,
  RoomReplyGenerationError,
  __setCreateResolvedAgentSession,
  __resetChatState,
} from "../chat.js";

const mockChatStore = {
  listRoomMembers: vi.fn(),
  createSession: vi.fn(),
  getRoom: vi.fn(),
  addRoomMessage: vi.fn(),
  getRoomMessages: vi.fn(),
};

const mockAgentStore = {
  init: vi.fn(),
  getAgent: vi.fn(),
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
    mockChatStore.getRoomMessages.mockReturnValue([]);
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
      mockAgentStore.getAgent.mockResolvedValue({ id: "agent-a", name: "Alpha", role: "executor" });

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

    it("requests responder and enabled plugin skills for room responder sessions", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([
        {
          id: "agent-a",
          name: "Alpha",
          role: "executor",
          runtimeConfig: {},
          metadata: { skills: ["room-agent-debug"] },
        },
      ]);
      let createOptions: any;
      __setCreateResolvedAgentSession(async (options: any) => {
        createOptions = options;
        return {
          session: {
            prompt: vi.fn(),
            dispose: vi.fn(),
            state: {
              messages: [{ role: "assistant", content: "Room reply" }],
            },
          },
        } as any;
      });
      const pluginRunner = {
        getPluginSkills: vi.fn(() => [
          { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-debug", enabled: true } },
          { pluginId: "disabled-plugin", skill: { name: "disabled-debug", enabled: false } },
        ]),
      };

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any, pluginRunner as any);
      await manager.sendRoomMessage("room-1", "hello @Alpha");

      expect(pluginRunner.getPluginSkills).toHaveBeenCalledTimes(1);
      expect(createOptions.skillSelection).toMatchObject({
        projectRootDir: "/tmp",
        sessionPurpose: "heartbeat",
      });
      expect(createOptions.skillSelection.requestedSkillNames).toEqual(["room-agent-debug", "ce-debug"]);
      expect(createOptions.skillSelection.requestedSkillNames).not.toContain("disabled-debug");
    });

    it("loads typed /skill commands for room responders and strips them from the room prompt", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([
        {
          id: "agent-a",
          name: "Alpha",
          role: "executor",
          runtimeConfig: {},
          metadata: { skills: ["room-agent-debug"] },
        },
      ]);
      const promptSpy = vi.fn().mockResolvedValue(undefined);
      let createOptions: any;
      __setCreateResolvedAgentSession(async (options: any) => {
        createOptions = options;
        return {
          session: {
            prompt: promptSpy,
            dispose: vi.fn(),
            state: {
              messages: [{ role: "assistant", content: "Room reply" }],
            },
          },
        } as any;
      });

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
      await manager.sendRoomMessage("room-1", "/skill:ce-debug hello @Alpha");

      expect(createOptions.skillSelection).toMatchObject({
        projectRootDir: "/tmp",
        sessionPurpose: "heartbeat",
      });
      expect(createOptions.skillSelection.requestedSkillNames).toEqual(["room-agent-debug", "ce-debug"]);
      expect(promptSpy).toHaveBeenCalledTimes(1);
      const roomPrompt = promptSpy.mock.calls[0]?.[0] as string;
      expect(roomPrompt).toContain("Latest user message to answer:\n\nhello @Alpha");
      expect(roomPrompt).not.toContain("/skill:");
      expect(mockChatStore.addRoomMessage.mock.calls[0]?.[1]).toMatchObject({
        role: "user",
        content: "/skill:ce-debug hello @Alpha",
      });
    });

    it("suppresses trimmed skip sentinel replies while persisting normal co-responder replies", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
        { roomId: "room-1", agentId: "agent-b", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([
        { id: "agent-a", name: "Alpha", role: "executor" },
        { id: "agent-b", name: "Beta", role: "executor" },
      ]);

      const replySpy = vi.spyOn(ChatManager.prototype as any, "generateRoomResponderReply")
        .mockResolvedValueOnce({ content: `  ${ROOM_SKIP_SENTINEL}  `, thinkingOutput: null })
        .mockResolvedValueOnce({ content: "Room reply from Beta", thinkingOutput: null });

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
      const result = await manager.sendRoomMessage("room-1", "hello");

      expect(result.responders).toEqual(["agent-b"]);

      const assistantWrites = mockChatStore.addRoomMessage.mock.calls
        .map((call: any[]) => call[1])
        .filter((entry: any) => entry.role === "assistant");
      expect(assistantWrites).toHaveLength(1);
      expect(assistantWrites[0]).toMatchObject({
        content: "Room reply from Beta",
        senderAgentId: "agent-b",
      });

      replySpy.mockRestore();
    });

    it("treats all-skip responder outcomes as intentional no-op without throwing", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([{ id: "agent-a", name: "Alpha", role: "executor" }]);

      const replySpy = vi.spyOn(ChatManager.prototype as any, "generateRoomResponderReply")
        .mockResolvedValue({ content: ` ${ROOM_SKIP_SENTINEL} `, thinkingOutput: null });

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
      await expect(manager.sendRoomMessage("room-1", "hello")).resolves.toMatchObject({ responders: [] });

      const assistantWrites = mockChatStore.addRoomMessage.mock.calls
        .map((call: any[]) => call[1])
        .filter((entry: any) => entry.role === "assistant");
      expect(assistantWrites).toHaveLength(0);

      replySpy.mockRestore();
    });

    it("persists replies that only contain the skip token as a substring", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([{ id: "agent-a", name: "Alpha", role: "executor" }]);

      const replySpy = vi.spyOn(ChatManager.prototype as any, "generateRoomResponderReply")
        .mockResolvedValue({ content: "use __SKIP__ as a token", thinkingOutput: null });

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
      const result = await manager.sendRoomMessage("room-1", "hello");

      expect(result.responders).toEqual(["agent-a"]);
      const assistantWrite = mockChatStore.addRoomMessage.mock.calls
        .map((call: any[]) => call[1])
        .find((entry: any) => entry.role === "assistant");
      expect(assistantWrite).toMatchObject({ content: "use __SKIP__ as a token" });

      replySpy.mockRestore();
    });

    it("fails deterministically when no member responder can be resolved", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockRejectedValue(new Error("list failed"));
      mockAgentStore.getAgent.mockResolvedValue(null);

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);

      await expect(manager.sendRoomMessage("room-1", "hello")).rejects.toBeInstanceOf(RoomReplyGenerationError);
      expect(mockChatStore.addRoomMessage).toHaveBeenCalledTimes(1);
      expect(mockChatStore.addRoomMessage.mock.calls[0]?.[1]).toMatchObject({ role: "user", content: "hello" });
    });

    it("falls back to room-member getAgent lookup when listAgents fails", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockRejectedValue(new Error("list failed"));
      mockAgentStore.getAgent.mockResolvedValue({ id: "agent-a", name: "Alpha", role: "executor" });

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
      const result = await manager.sendRoomMessage("room-1", "hello");

      expect(result.responders).toEqual(["agent-a"]);

      const assistantWrite = mockChatStore.addRoomMessage.mock.calls[1]?.[1];
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

    it("includes bounded room transcript context in responder prompt", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([{ id: "agent-a", name: "Alpha", role: "executor" }]);
      mockAgentStore.getAgent.mockResolvedValue({ id: "agent-a", name: "Alpha", role: "executor" });

      const promptSpy = vi.fn().mockResolvedValue(undefined);
      __setCreateResolvedAgentSession(async () => ({
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Room reply" }],
          },
        },
      } as any));

      mockChatStore.getRoomMessages.mockReturnValue([
        { id: "msg-older", role: "user", senderAgentId: null, content: "Older user context", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "msg-assist", role: "assistant", senderAgentId: "agent-a", content: "Earlier assistant context", createdAt: "2026-01-01T00:00:01.000Z" },
        { id: "msg-1", role: "user", senderAgentId: null, content: "hello @Alpha", createdAt: "2026-01-01T00:00:02.000Z" },
      ]);

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
      await manager.sendRoomMessage("room-1", "hello @Alpha");

      const prompt = promptSpy.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("Room transcript (oldest to newest, bounded):");
      expect(prompt).toContain("Older user context");
      expect(prompt).toContain("Earlier assistant context");
      expect(prompt).toContain("[LATEST USER MESSAGE — ANSWER THIS]");
      expect(mockChatStore.getRoomMessages).toHaveBeenCalledWith("room-1", { limit: expect.any(Number) });
    });

    it("compacts older room context entries in the responder prompt", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([{ id: "agent-a", name: "Alpha", role: "executor" }]);
      mockAgentStore.getAgent.mockResolvedValue({ id: "agent-a", name: "Alpha", role: "executor" });

      const promptSpy = vi.fn().mockResolvedValue(undefined);
      mockChatStore.addRoomMessage.mockImplementationOnce((_roomId: string, input: any) => ({
        id: "history-latest",
        roomId: "room-1",
        ...input,
      }));
      __setCreateResolvedAgentSession(async () => ({
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Room reply" }],
          },
        },
      } as any));

      const history = Array.from({ length: 30 }, (_, index) => ({
        id: `msg-${index + 1}`,
        role: index % 2 === 0 ? "user" : "assistant",
        senderAgentId: index % 2 === 0 ? null : "agent-a",
        content: `history-item-${index}`,
        createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      }));
      history[history.length - 1] = {
        ...history[history.length - 1],
        id: "history-latest",
        role: "user",
        senderAgentId: null,
        content: "hello @Alpha",
      };
      mockChatStore.getRoomMessages.mockImplementation((_roomId: string, filter?: { limit?: number }) => {
        const limit = filter?.limit ?? history.length;
        return history.slice(-limit);
      });

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
      await manager.sendRoomMessage("room-1", "hello @Alpha");

      const prompt = promptSpy.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("## Earlier room context (compacted)");
      expect(prompt).toContain("- Span: 5 messages from 2026-01-01T00:00:00.000Z to 2026-01-01T00:00:04.000Z");
      expect(prompt).toContain("history-item-28");
      expect(prompt).toContain("  - [2026-01-01T00:00:00.000Z] User: history-item-0");
      expect(prompt).not.toContain("- [2026-01-01T00:00:00.000Z] (user) User: history-item-0");
      expect(prompt).toContain("- [2026-01-01T00:00:29.000Z] (user) User: hello @Alpha [LATEST USER MESSAGE — ANSWER THIS]");
      expect(prompt.match(/\[LATEST USER MESSAGE — ANSWER THIS\]/g)).toHaveLength(1);
    });

    it("uses project chat room compaction settings at responder time", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([{ id: "agent-a", name: "Alpha", role: "executor" }]);
      mockAgentStore.getAgent.mockResolvedValue({ id: "agent-a", name: "Alpha", role: "executor" });

      const promptSpy = vi.fn().mockResolvedValue(undefined);
      mockChatStore.addRoomMessage.mockImplementationOnce((_roomId: string, input: any) => ({
        id: "history-latest",
        roomId: "room-1",
        ...input,
      }));
      __setCreateResolvedAgentSession(async () => ({
        session: {
          prompt: promptSpy,
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Room reply" }],
          },
        },
      } as any));

      const history = Array.from({ length: 15 }, (_, index) => ({
        id: `msg-${index + 1}`,
        role: index % 2 === 0 ? "user" : "assistant",
        senderAgentId: index % 2 === 0 ? null : "agent-a",
        content: `history-item-${index}`,
        createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      }));
      history[history.length - 1] = {
        ...history[history.length - 1],
        id: "history-latest",
        role: "user",
        senderAgentId: null,
        content: "hello @Alpha",
      };
      mockChatStore.getRoomMessages.mockImplementation((_roomId: string, filter?: { limit?: number }) => {
        const limit = filter?.limit ?? history.length;
        return history.slice(-limit);
      });

      const manager = new ChatManager(
        mockChatStore as any,
        "/tmp",
        mockAgentStore as any,
        undefined,
        async () => ({
          fallbackProvider: undefined,
          fallbackModelId: undefined,
          defaultProvider: undefined,
          defaultModelId: undefined,
          chatRoomRecentVerbatimMessages: 3,
          chatRoomCompactionFetchLimit: 10,
          chatRoomSummaryMaxChars: 400,
        }),
      );
      await manager.sendRoomMessage("room-1", "hello @Alpha");

      expect(mockChatStore.getRoomMessages).toHaveBeenCalledWith("room-1", { limit: 10 });
      const prompt = promptSpy.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("## Earlier room context (compacted)");
      expect(prompt).toContain("history-item-12");
      expect(prompt).toContain("history-item-13");
      expect(prompt).toContain("hello @Alpha [LATEST USER MESSAGE — ANSWER THIS]");
      expect(prompt).not.toContain("- [2026-01-01T00:00:11.000Z] (assistant) Agent agent-a: history-item-11");
    });

    it("throws surfaced error when room has members but no resolvable responders", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([]);
      mockAgentStore.getAgent.mockResolvedValue(null);

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
      await expect(manager.sendRoomMessage("room-1", "hello")).rejects.toThrow(
        "No active room responders available for room room-1",
      );
    });

    it("passes resolved-session runtime options when generating room replies", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([
        {
          id: "agent-a",
          name: "Alpha",
          role: "executor",
          runtimeConfig: { model: "anthropic/claude-sonnet-4-5", runtimeHint: "openclaw" },
        },
      ]);
      mockAgentStore.getAgent.mockResolvedValue({
        id: "agent-a",
        name: "Alpha",
        role: "executor",
        runtimeConfig: { model: "anthropic/claude-sonnet-4-5", runtimeHint: "openclaw" },
      });

      const createResolvedSession = vi.fn().mockResolvedValue({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "Room reply" }],
          },
        },
      });
      __setCreateResolvedAgentSession(createResolvedSession as any);

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
      await manager.sendRoomMessage("room-1", "hello @Alpha");

      expect(createResolvedSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionPurpose: "heartbeat",
        pluginRunner: undefined,
        runtimeHint: "openclaw",
        cwd: "/tmp",
        systemPrompt: expect.any(String),
        tools: "coding",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      }));
      expect(createResolvedSession.mock.calls[0]?.[0]).not.toHaveProperty("createFnAgentArgs");
      expect(createResolvedSession.mock.calls[0]?.[0]).not.toHaveProperty("resolvedProvider");
      expect(createResolvedSession.mock.calls[0]?.[0]).not.toHaveProperty("resolvedModel");
    });

    it("throws surfaced error when all room responders fail to reply", async () => {
      mockChatStore.listRoomMembers.mockReturnValue([
        { roomId: "room-1", agentId: "agent-a", role: "member", addedAt: "2026-01-01" },
      ]);
      mockAgentStore.listAgents.mockResolvedValue([{ id: "agent-a", name: "Alpha", role: "executor" }]);
      mockAgentStore.getAgent.mockResolvedValue({ id: "agent-a", name: "Alpha", role: "executor" });

      __setCreateResolvedAgentSession(async () => ({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: {
            messages: [{ role: "assistant", content: "   " }],
          },
        },
      } as any));

      const manager = new ChatManager(mockChatStore as any, "/tmp", mockAgentStore as any);
      await expect(manager.sendRoomMessage("room-1", "hello @Alpha")).rejects.toThrow(
        /Failed to generate room replies for room room-1:/,
      );

      const assistantWrites = mockChatStore.addRoomMessage.mock.calls
        .map((call: any[]) => call[1])
        .filter((input: any) => input.role === "assistant" && input.senderAgentId);
      expect(assistantWrites).toHaveLength(0);
    });
  });
});

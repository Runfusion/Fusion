import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildQmdAgentMemoryCollectionAddArgs,
  buildQmdAgentMemorySearchArgs,
  createMemoryTools,
  createTaskCreateTool,
  createSendMessageTool,
  createReadMessagesTool,
  qmdAgentMemoryCollectionName,
  sendMessageParams,
  readMessagesParams,
} from "./agent-tools.js";
import type { MessageStore, Message } from "@fusion/core";

const loggerSpies = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const execFileMock = vi.hoisted(() => vi.fn());
const readdirMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  readdirMock.mockImplementation(((...args: Parameters<typeof actual.readdir>) => actual.readdir(...args)) as typeof actual.readdir);
  return {
    ...actual,
    readdir: readdirMock,
  };
});

// Mock logger
vi.mock("./logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: loggerSpies.log,
    warn: loggerSpies.warn,
    error: loggerSpies.error,
  })),
  heartbeatLog: {
    log: loggerSpies.log,
    warn: loggerSpies.warn,
    error: loggerSpies.error,
  },
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: execFileMock,
  };
});

describe("createTaskCreateTool", () => {
  it("returns details.taskId and keeps Created <id> response text", async () => {
    const store = {
      createTask: vi.fn().mockResolvedValue({
        id: "PROJ-042",
        description: "Follow-up task",
        dependencies: ["PROJ-001"],
        column: "triage",
      }),
    };

    const tool = createTaskCreateTool(store as any);
    const result = await tool.execute(
      "call-1",
      {
        description: "Follow-up task",
        dependencies: ["PROJ-001"],
      } as any,
      undefined,
      undefined,
      {} as any,
    );

    expect(store.createTask).toHaveBeenCalledWith({
      description: "Follow-up task",
      dependencies: ["PROJ-001"],
      column: "triage",
    });
    expect(result.details).toEqual({ taskId: "PROJ-042" });
    const responseText = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(responseText).toContain("Created PROJ-042: Follow-up task");
    expect(responseText).toContain("(depends on: PROJ-001)");
  });
});

describe("createMemoryTools", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS;
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        callback(null, "", "");
      }
      return undefined;
    });
    tempDir = await mkdtemp(join(tmpdir(), "agent-memory-tools-"));
  });

  afterEach(async () => {
    delete process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("omits memory tools when memory is disabled", () => {
    expect(createMemoryTools("/repo", { memoryEnabled: false }).map((tool) => tool.name)).toEqual([]);
  });

  it("omits memory_append for read-only memory backends", () => {
    expect(createMemoryTools("/repo", { memoryBackendType: "readonly" }).map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_get",
    ]);
  });

  it("includes memory_append for writable memory backends", () => {
    expect(createMemoryTools("/repo", { memoryBackendType: "file" }).map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_get",
      "memory_append",
    ]);
  });

  it("searches per-agent memory through the memory_search tool", async () => {
    const [searchTool, getTool] = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "The CEO agent should prioritize roadmap sequencing and delegation.",
      },
    });

    const searchResult = await (searchTool as any).execute("call-1", {
      query: "roadmap delegation",
      limit: 5,
    }, undefined, undefined, undefined);

    expect(searchResult.content[0]!.text).toContain(".fusion/agent-memory/ceo-agent/MEMORY.md");
    expect(searchResult.details.results[0].backend).toBe("agent-memory");

    const getResult = await (getTool as any).execute("call-2", {
      path: ".fusion/agent-memory/ceo-agent/MEMORY.md",
      startLine: 1,
      lineCount: 20,
    }, undefined, undefined, undefined);

    expect(getResult.content[0]!.text).toContain("Agent Memory: CEO");
    expect(getResult.content[0]!.text).toContain("roadmap sequencing");
  });

  it("creates daily and dreams files for per-agent memory lookup", async () => {
    const [searchTool] = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "The CEO agent should prioritize roadmap sequencing and delegation.",
      },
    });

    await (searchTool as any).execute("call-1", {
      query: "roadmap",
      limit: 5,
    }, undefined, undefined, undefined);

    const today = new Date().toISOString().slice(0, 10);
    await expect(readFile(join(tempDir, ".fusion", "agent-memory", "ceo-agent", "MEMORY.md"), "utf-8"))
      .resolves.toContain("Agent Memory: CEO");
    await expect(readFile(join(tempDir, ".fusion", "agent-memory", "ceo-agent", "DREAMS.md"), "utf-8"))
      .resolves.toContain("Agent Memory Dreams");
    await expect(readFile(join(tempDir, ".fusion", "agent-memory", "ceo-agent", `${today}.md`), "utf-8"))
      .resolves.toContain("Agent Daily Memory");
  });

  it("appends to this agent's daily memory through memory_append", async () => {
    const tools = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "The CEO agent should prioritize roadmap sequencing and delegation.",
      },
    });
    const appendTool = tools.find((tool) => tool.name === "memory_append")!;

    const result = await (appendTool as any).execute("call-1", {
      scope: "agent",
      layer: "daily",
      content: "- Follow up with execution agents after roadmap planning.",
    }, undefined, undefined, undefined);

    const today = new Date().toISOString().slice(0, 10);
    await expect(readFile(join(tempDir, ".fusion", "agent-memory", "ceo-agent", `${today}.md`), "utf-8"))
      .resolves.toContain("Follow up with execution agents");
    expect(result.details).toEqual({ scope: "agent", layer: "daily" });
  });

  it("memory_get reads agent dreams returned by memory_search", async () => {
    const [, getTool, appendTool] = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "The CEO agent should prioritize roadmap sequencing and delegation.",
      },
    });
    await (appendTool as any).execute("call-1", {
      scope: "agent",
      layer: "daily",
      content: "- Daily note",
    }, undefined, undefined, undefined);

    const getResult = await (getTool as any).execute("call-2", {
      path: ".fusion/agent-memory/ceo-agent/DREAMS.md",
      startLine: 1,
      lineCount: 10,
    }, undefined, undefined, undefined);

    expect(getResult.content[0]!.text).toContain("Agent Memory Dreams");
  });

  it("builds qmd collection and search args for separate agent memory", () => {
    expect(buildQmdAgentMemoryCollectionAddArgs(tempDir, "ceo-agent")).toEqual([
      "collection",
      "add",
      join(tempDir, ".fusion", "agent-memory", "ceo-agent"),
      "--name",
      qmdAgentMemoryCollectionName(tempDir, "ceo-agent"),
      "--mask",
      "**/*.md",
    ]);
    expect(buildQmdAgentMemorySearchArgs(tempDir, "ceo-agent", "delegation", 7)).toEqual([
      "search",
      "delegation",
      "--json",
      "--collection",
      qmdAgentMemoryCollectionName(tempDir, "ceo-agent"),
      "-n",
      "7",
    ]);
  });


  it("logs a warning and continues when agent memory directory read fails", async () => {
    readdirMock.mockRejectedValueOnce(new Error("EACCES"));

    const [searchTool] = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "Roadmap delegation priorities are tracked here.",
      },
    });

    const result = await (searchTool as any).execute("call-1", {
      query: "delegation",
      limit: 5,
    }, undefined, undefined, undefined);

    expect(result.content[0]!.text).toContain(".fusion/agent-memory/ceo-agent/MEMORY.md");
    expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to read agent memory directory"));
    expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  it("logs a warning and falls back to file search when qmd search fails", async () => {
    process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS = "1";
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      const commandArgs = args[1] as string[];
      if (typeof callback === "function") {
        if (Array.isArray(commandArgs) && commandArgs[0] === "search") {
          callback(new Error("qmd search failed"), "", "");
          return undefined;
        }
        callback(null, "", "");
      }
      return undefined;
    });

    const [searchTool] = createMemoryTools(tempDir, { memoryBackendType: "qmd" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "Roadmap delegation priorities are tracked here.",
      },
    });

    const result = await (searchTool as any).execute("call-1", {
      query: "delegation",
      limit: 5,
    }, undefined, undefined, undefined);

    expect(result.details.results[0].backend).toBe("agent-memory");
    expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("QMD agent memory search failed for agent ceo-agent"));
    expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("qmd search failed"));
  });

  it("logs a warning when background qmd refresh fails after memory append", async () => {
    process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS = "1";
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        callback(new Error("qmd refresh failed"), "", "");
      }
      return undefined;
    });

    const tools = createMemoryTools(tempDir, { memoryBackendType: "qmd" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "Roadmap delegation priorities are tracked here.",
      },
    });
    const appendTool = tools.find((tool) => tool.name === "memory_append")!;

    const result = await (appendTool as any).execute("call-1", {
      scope: "agent",
      layer: "daily",
      content: "- Follow up on delegated roadmap work.",
    }, undefined, undefined, undefined);

    expect(result.content[0]!.text).toContain("Appended to agent daily memory.");
    await vi.waitFor(() => {
      expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("Agent memory QMD index refresh failed for ceo-agent"));
    });
    expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("qmd refresh failed"));
  });
});

function createMessage(overrides: Partial<Message> = {}): Message {
  const now = new Date().toISOString();
  return {
    id: "msg-001",
    fromId: "user-1",
    fromType: "user",
    toId: "agent-1",
    toType: "agent",
    content: "Test message",
    type: "agent-to-agent",
    read: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createMockMessageStore(overrides: Partial<MessageStore> = {}): MessageStore {
  return {
    sendMessage: vi.fn(),
    getInbox: vi.fn().mockReturnValue([]),
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    ...overrides,
  } as unknown as MessageStore;
}

describe("createSendMessageTool", () => {
  let messageStore: ReturnType<typeof createMockMessageStore>;
  let tool: ReturnType<typeof createSendMessageTool>;

  beforeEach(() => {
    messageStore = createMockMessageStore();
    tool = createSendMessageTool(messageStore, "agent-sender");
  });

  // Helper to call tool execute with correct signature
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const executeTool = async (tool: any, params: unknown) => {
    return tool.execute("call-1", params, undefined, undefined, undefined);
  };

  it("creates a tool with name 'send_message'", () => {
    expect(tool.name).toBe("send_message");
  });

  it("creates a tool with correct label", () => {
    expect(tool.label).toBe("Send Message");
  });

  it("creates a tool with a description mentioning recipient waking and reply linking", () => {
    expect(tool.description).toContain("messageResponseMode");
    expect(tool.description).toContain("reply_to_message_id");
  });

  it("calls messageStore.sendMessage with correct parameters", async () => {
    const mockMessage = createMessage({ id: "msg-123" });
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    const result = await executeTool(tool, {
      to_id: "agent-recipient",
      content: "Hello, world!",
    });

    expect(messageStore.sendMessage).toHaveBeenCalledWith({
      fromId: "agent-sender",
      fromType: "agent",
      toId: "agent-recipient",
      toType: "agent",
      content: "Hello, world!",
      type: "agent-to-agent",
    });
    expect(result.content[0]).toEqual({ type: "text", text: "Message sent to agent-recipient (ID: msg-123)" });
    expect(result.details).toEqual({ messageId: "msg-123" });
  });

  it("defaults type to 'agent-to-agent' when not specified", async () => {
    const mockMessage = createMessage();
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    await executeTool(tool, {
      to_id: "agent-2",
      content: "Test",
    });

    expect(messageStore.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent-to-agent" })
    );
  });

  it("uses provided type when specified and maps recipient type for agent-to-user", async () => {
    const mockMessage = createMessage({ toType: "user", type: "agent-to-user" });
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    await executeTool(tool, {
      to_id: "user-1",
      content: "Test",
      type: "agent-to-user",
    });

    expect(messageStore.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent-to-user", toType: "user" })
    );
  });

  it("maps recipient type to agent for agent-to-agent messages", async () => {
    const mockMessage = createMessage({ toType: "agent", type: "agent-to-agent" });
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    await executeTool(tool, {
      to_id: "agent-2",
      content: "Test",
      type: "agent-to-agent",
    });

    expect(messageStore.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent-to-agent", toType: "agent" })
    );
  });

  it("persists reply metadata when reply_to_message_id is provided", async () => {
    const mockMessage = createMessage({ id: "msg-reply" });
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    await executeTool(tool, {
      to_id: "agent-2",
      content: "Following up",
      reply_to_message_id: "msg-original",
    });

    expect(messageStore.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { replyTo: { messageId: "msg-original" } } })
    );
  });

  it("rejects blank reply_to_message_id", async () => {
    const result = await executeTool(tool, {
      to_id: "agent-2",
      content: "Following up",
      reply_to_message_id: "   ",
    });

    expect(result.content[0]).toEqual({ type: "text", text: "ERROR: reply_to_message_id must be a non-empty string" });
    expect(messageStore.sendMessage).not.toHaveBeenCalled();
  });

  it("returns error for empty content", async () => {
    const result = await executeTool(tool, {
      to_id: "agent-2",
      content: "   ",
    });

    expect(result.content[0]).toEqual({ type: "text", text: "ERROR: Message content cannot be empty" });
    expect(messageStore.sendMessage).not.toHaveBeenCalled();
  });

  it("returns error for content exceeding 2000 characters", async () => {
    const longContent = "a".repeat(2001);
    const result = await executeTool(tool, {
      to_id: "agent-2",
      content: longContent,
    });

    expect(result.content[0]).toEqual({ type: "text", text: "ERROR: Message content exceeds 2000 character limit" });
    expect(messageStore.sendMessage).not.toHaveBeenCalled();
  });

  it("returns error when messageStore.sendMessage throws", async () => {
    vi.mocked(messageStore.sendMessage).mockImplementation(() => {
      throw new Error("Database error");
    });

    const result = await executeTool(tool, {
      to_id: "agent-2",
      content: "Test",
    });

    expect(result.content[0]).toEqual({ type: "text", text: "ERROR: Failed to send message: Database error" });
  });

  it("trims content before validation", async () => {
    const mockMessage = createMessage();
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    const result = await executeTool(tool, {
      to_id: "agent-2",
      content: "   test   ",
    });

    expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("Message sent") });
    expect(messageStore.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "test" })
    );
  });
});

describe("createReadMessagesTool", () => {
  let messageStore: ReturnType<typeof createMockMessageStore>;
  let tool: ReturnType<typeof createReadMessagesTool>;

  beforeEach(() => {
    messageStore = createMockMessageStore();
    tool = createReadMessagesTool(messageStore, "agent-1");
  });

  // Helper to call tool execute with correct signature
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const executeTool = async (tool: any, params: unknown) => {
    return tool.execute("call-1", params, undefined, undefined, undefined);
  };

  it("creates a tool with name 'read_messages'", () => {
    expect(tool.name).toBe("read_messages");
  });

  it("creates a tool with correct label", () => {
    expect(tool.label).toBe("Read Messages");
  });

  it("creates a tool with description mentioning unread messages", () => {
    expect(tool.description).toContain("unread messages");
  });

  it("calls messageStore.getInbox with correct agent ID", async () => {
    await executeTool(tool, {});

    expect(messageStore.getInbox).toHaveBeenCalledWith("agent-1", "agent", expect.any(Object));
  });

  it("defaults to unread_only: true", async () => {
    await executeTool(tool, {});

    expect(messageStore.getInbox).toHaveBeenCalledWith("agent-1", "agent", {
      read: false,
      limit: 20,
    });
  });

  it("uses provided unread_only value", async () => {
    await executeTool(tool, { unread_only: false });

    expect(messageStore.getInbox).toHaveBeenCalledWith("agent-1", "agent", {
      limit: 20,
    });
  });

  it("uses provided limit value", async () => {
    await executeTool(tool, { limit: 5 });

    expect(messageStore.getInbox).toHaveBeenCalledWith("agent-1", "agent", {
      read: false,
      limit: 5,
    });
  });

  it("returns 'No messages' when inbox is empty", async () => {
    vi.mocked(messageStore.getInbox).mockReturnValue([]);

    const result = await executeTool(tool, {});

    expect(result.content[0]).toEqual({ type: "text", text: "No messages" });
  });

  it("returns formatted message list with message IDs, sender, content, and timestamp", async () => {
    const messages = [
      createMessage({
        id: "msg-1",
        fromId: "agent-2",
        fromType: "agent",
        content: "Hello there",
        createdAt: "2024-01-15T10:30:00.000Z",
        read: false,
      }),
      createMessage({
        id: "msg-2",
        fromId: "user-1",
        fromType: "user",
        content: "Another message",
        createdAt: "2024-01-15T11:00:00.000Z",
        read: true,
      }),
    ];
    vi.mocked(messageStore.getInbox).mockReturnValue(messages);

    const result = await executeTool(tool, {});

    const text = result.content[0];
    expect(text).toMatchObject({ type: "text" });
    expect((text as { text: string }).text).toContain("Messages (2)");
    expect((text as { text: string }).text).toContain("[unread] [id: msg-1] [from: agent:agent-2] Hello there");
    expect((text as { text: string }).text).toContain("[read] [id: msg-2] [from: user:user-1] Another message");
    expect(result.details).toEqual({ messages });
  });

  it("returns error when messageStore.getInbox throws", async () => {
    vi.mocked(messageStore.getInbox).mockImplementation(() => {
      throw new Error("Database error");
    });

    const result = await executeTool(tool, {});

    expect(result.content[0]).toEqual({ type: "text", text: "ERROR: Failed to read messages: Database error" });
  });

  it("uses default limit of 20", async () => {
    vi.mocked(messageStore.getInbox).mockReturnValue([]);

    await executeTool(tool, { unread_only: false });

    expect(messageStore.getInbox).toHaveBeenCalledWith("agent-1", "agent", { limit: 20 });
  });
});

describe("sendMessageParams schema", () => {
  it("is defined and exported", () => {
    expect(sendMessageParams).toBeDefined();
  });
});

describe("readMessagesParams schema", () => {
  it("is defined and exported", () => {
    expect(readMessagesParams).toBeDefined();
  });
});

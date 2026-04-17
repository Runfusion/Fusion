import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryTools, createSendMessageTool, createReadMessagesTool, sendMessageParams, readMessagesParams } from "./agent-tools.js";
import type { MessageStore, Message } from "@fusion/core";

// Mock logger
vi.mock("./logger.js", () => {
  const createMockLogger = () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
  };
});

describe("createMemoryTools", () => {
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

  it("creates a tool with a description mentioning recipient waking", () => {
    expect(tool.description).toContain("messageResponseMode");
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

  it("returns formatted message list with sender, content, and timestamp", async () => {
    const messages = [
      createMessage({
        id: "msg-1",
        fromId: "agent-2",
        content: "Hello there",
        createdAt: "2024-01-15T10:30:00.000Z",
        read: false,
      }),
      createMessage({
        id: "msg-2",
        fromId: "user-1",
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
    expect((text as { text: string }).text).toContain("[unread] [from: agent-2] Hello there");
    expect((text as { text: string }).text).toContain("[read] [from: user-1] Another message");
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

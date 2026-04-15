import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock MessageStore ────────────────────────────────────────────────

const mockGetInbox = vi.fn();
const mockGetOutbox = vi.fn();
const mockGetMailbox = vi.fn();
const mockGetMessage = vi.fn();
const mockSendMessage = vi.fn();
const mockMarkAsRead = vi.fn();
const mockDeleteMessage = vi.fn();

vi.mock("@fusion/core", () => {
  const mockDb = {
    init: vi.fn(),
    close: vi.fn(),
  };
  return {
    createDatabase: vi.fn().mockReturnValue(mockDb),
    MessageStore: vi.fn().mockImplementation(() => ({
      getInbox: mockGetInbox,
      getOutbox: mockGetOutbox,
      getMailbox: mockGetMailbox,
      getMessage: mockGetMessage,
      sendMessage: mockSendMessage,
      markAsRead: mockMarkAsRead,
      deleteMessage: mockDeleteMessage,
    })),
  };
});

// ── Mock project-context ─────────────────────────────────────────────

vi.mock("../project-context.js", () => ({
  resolveProject: vi.fn().mockResolvedValue({
    projectId: "test-project",
    projectPath: "/tmp/test-project",
    projectName: "test-project",
    isRegistered: true,
    store: {},
  }),
}));

// ── Spies ───────────────────────────────────────────────────────────

const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit");
}) as any);

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

// ── Import after mocks ───────────────────────────────────────────────

import {
  runMessageInbox,
  runMessageOutbox,
  runMessageSend,
  runMessageRead,
  runMessageDelete,
  runAgentMailbox,
} from "../message.js";

// ── Test Data ─────────────────────────────────────────────────────────

const mockMessage = {
  id: "msg-001",
  fromId: "agent-001",
  fromType: "agent" as const,
  toId: "cli",
  toType: "user" as const,
  content: "Hello from the agent",
  type: "agent-to-user" as const,
  read: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockReadMessage = {
  ...mockMessage,
  id: "msg-002",
  read: true,
  content: "This is read",
};

// ── Tests ───────────────────────────────────────────────────────────

describe("runMessageInbox", () => {
  beforeEach(() => {
    mockGetMailbox.mockReturnValue({ unreadCount: 2, ownerId: "cli", ownerType: "user" });
    mockGetInbox.mockReturnValue([mockMessage, mockReadMessage]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should list inbox messages with unread count", async () => {
    await runMessageInbox();

    expect(mockGetInbox).toHaveBeenCalledWith("cli", "user", { limit: 20 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Inbox"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("2 unread"));
  });

  it("should show 'No messages' when inbox is empty", async () => {
    mockGetMailbox.mockReturnValue({ unreadCount: 0, ownerId: "cli", ownerType: "user" });
    mockGetInbox.mockReturnValue([]);

    await runMessageInbox();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No messages"));
  });

  it("should show unread marker for unread messages", async () => {
    await runMessageInbox();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("●"));
  });

  it("should truncate long messages", async () => {
    mockGetInbox.mockReturnValue([{
      ...mockMessage,
      content: "A".repeat(200),
    }]);
    mockGetMailbox.mockReturnValue({ unreadCount: 1, ownerId: "cli", ownerType: "user" });

    await runMessageInbox();

    // Should truncate to 80 chars + "…"
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("…"));
  });
});

describe("runMessageOutbox", () => {
  beforeEach(() => {
    mockGetOutbox.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should list sent messages", async () => {
    const sentMessage = {
      ...mockMessage,
      fromId: "cli",
      fromType: "user" as const,
      toId: "agent-001",
      toType: "agent" as const,
      type: "user-to-agent" as const,
    };
    mockGetOutbox.mockReturnValue([sentMessage]);

    await runMessageOutbox();

    expect(mockGetOutbox).toHaveBeenCalledWith("cli", "user", { limit: 20 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Outbox"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Agent agent-001"));
  });

  it("should show 'No sent messages' when outbox is empty", async () => {
    mockGetOutbox.mockReturnValue([]);

    await runMessageOutbox();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No sent messages"));
  });
});

describe("runMessageSend", () => {
  beforeEach(() => {
    mockSendMessage.mockReturnValue(mockMessage);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should send a message to an agent", async () => {
    await runMessageSend("agent-001", "Hello agent!");

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        fromId: "cli",
        fromType: "user",
        toId: "agent-001",
        toType: "agent",
        content: "Hello agent!",
        type: "user-to-agent",
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("✓ Message sent"));
  });

  it("should show the message ID after sending", async () => {
    await runMessageSend("agent-001", "Test message");

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("msg-001"));
  });
});

describe("runMessageRead", () => {
  beforeEach(() => {
    mockGetMessage.mockReturnValue(mockMessage);
    mockMarkAsRead.mockReturnValue({ ...mockMessage, read: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should display a message and mark as read", async () => {
    await runMessageRead("msg-001");

    expect(mockGetMessage).toHaveBeenCalledWith("msg-001");
    expect(mockMarkAsRead).toHaveBeenCalledWith("msg-001");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("msg-001"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Hello from the agent"));
  });

  it("should show message details", async () => {
    await runMessageRead("msg-001");

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("agent-to-user"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Agent agent-001"));
  });

  it("should not mark as read if already read", async () => {
    mockGetMessage.mockReturnValue(mockReadMessage);

    await runMessageRead("msg-002");

    expect(mockMarkAsRead).not.toHaveBeenCalled();
  });

  it("should exit with error for missing message", async () => {
    mockGetMessage.mockReturnValue(null);

    await expect(runMessageRead("msg-nonexistent")).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runMessageDelete", () => {
  beforeEach(() => {
    mockDeleteMessage.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should delete a message", async () => {
    await runMessageDelete("msg-001");

    expect(mockDeleteMessage).toHaveBeenCalledWith("msg-001");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("✓ Message msg-001 deleted"));
  });
});

describe("runAgentMailbox", () => {
  beforeEach(() => {
    mockGetMailbox.mockReturnValue({ unreadCount: 1, ownerId: "agent-001", ownerType: "agent" });
    mockGetInbox.mockReturnValue([mockMessage]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should show agent mailbox with unread count", async () => {
    await runAgentMailbox("agent-001");

    expect(mockGetMailbox).toHaveBeenCalledWith("agent-001", "agent");
    expect(mockGetInbox).toHaveBeenCalledWith("agent-001", "agent", { limit: 20 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Agent Mailbox: agent-001"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("1 unread"));
  });

  it("should show 'No messages' when agent mailbox is empty", async () => {
    mockGetMailbox.mockReturnValue({ unreadCount: 0, ownerId: "agent-001", ownerType: "agent" });
    mockGetInbox.mockReturnValue([]);

    await runAgentMailbox("agent-001");

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No messages"));
  });

  it("should show messages with from label", async () => {
    await runAgentMailbox("agent-001");

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Agent agent-001"));
  });
});

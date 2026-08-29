import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAgent = vi.fn();
const mockGetConversation = vi.fn();
const mockGetInbox = vi.fn();
const mockSendMessage = vi.fn();
const mockMarkAsRead = vi.fn();
const mockClose = vi.fn();

vi.mock("@fusion/core", () => {
  class AgentStore {
    init = vi.fn(async () => undefined);
    getAgent = mockGetAgent;
    close = mockClose;
  }
  class MessageStore {
    getConversation = mockGetConversation;
    getInbox = mockGetInbox;
    sendMessage = mockSendMessage;
    markAsRead = mockMarkAsRead;
  }
  return { AgentStore, MessageStore, DASHBOARD_USER_ID: "dashboard" };
});

vi.mock("../../project-context.js", () => ({
  resolveAgentStoreBase: vi.fn(async () => ({
    rootDir: "/tmp/chat-test",
    asyncLayer: {},
    cleanup: vi.fn(async () => undefined),
  })),
}));

import { runChatInteractive } from "../chat.js";

function outputBuffer() {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  return { output, text: () => text };
}

function reply(id: string, content: string, replyTo?: string) {
  return {
    id,
    fromId: "agent-a",
    fromType: "agent" as const,
    toId: "cli",
    toType: "user" as const,
    content,
    type: "agent-to-user" as const,
    read: false,
    ...(replyTo ? { metadata: { replyTo: { messageId: replyTo } } } : {}),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

beforeEach(() => {
  mockGetAgent.mockResolvedValue({ id: "agent-a" });
  mockGetConversation.mockResolvedValue([]);
  mockGetInbox.mockResolvedValue([]);
  mockSendMessage.mockImplementation(async () => ({ id: `outbound-${mockSendMessage.mock.calls.length}` }));
  mockMarkAsRead.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("runChatInteractive", () => {
  it("prints a reply delivered to the CLI mailbox for a one-shot CLI message", async () => {
    const { output, text } = outputBuffer();
    const replies = [reply("reply-1", "board review complete", "outbound-1")];
    mockGetInbox.mockImplementation(async () => replies);

    const code = await runChatInteractive("agent-a", {
      once: true,
      nonInteractive: true,
      input: Readable.from(["review the board"]),
      output,
      pollIntervalMs: 1,
      replyTimeoutMs: 100,
    });

    expect(code).toBe(0);
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ fromId: "cli", toId: "agent-a" }));
    expect(text()).toContain("board review complete");
    expect(mockMarkAsRead).toHaveBeenCalledWith("reply-1");
  });

  it("returns at the reply deadline rather than a large poll interval", async () => {
    vi.useFakeTimers();
    const { output } = outputBuffer();
    const command = runChatInteractive("agent-a", {
      once: true,
      nonInteractive: true,
      input: Readable.from(["ping"]),
      output,
      pollIntervalMs: 300_000,
      replyTimeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(command).resolves.toBe(0);
  });

  it("expires one interactive pending reply but keeps polling for a later reply", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const { output, text } = outputBuffer();
    const replies: ReturnType<typeof reply>[] = [];
    mockGetInbox.mockImplementation(async () => replies);

    const command = runChatInteractive("agent-a", {
      input,
      output,
      pollIntervalMs: 300_000,
      replyTimeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    input.write("first request\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_001);
    expect(text()).toContain("No reply within 5s for: first request");

    input.write("second request\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    replies.push(reply("reply-2", "second answer", "outbound-2"));
    // The only scheduled poll is capped by the second request's own deadline,
    // not the 300-second normal interval.
    await vi.advanceTimersByTimeAsync(5_001);

    expect(text()).toContain("second answer");
    expect(text()).not.toContain("No reply within 5s for: second request");
    input.end("/exit\n");
    await expect(command).resolves.toBe(0);
  });
});

describe("named mailbox conversations", () => {
  it("stamps a stable conversation ID and leaves unrelated agent mail unread", async () => {
    const { output, text } = outputBuffer();
    mockGetInbox.mockResolvedValue([
      reply("other-thread", "other mailbox traffic"),
      reply("thread-reply", "threaded answer", "outbound-1"),
    ]);

    await runChatInteractive("agent-a", {
      once: true,
      nonInteractive: true,
      input: Readable.from(["status"]),
      output,
      pollIntervalMs: 1,
      replyTimeoutMs: 100,
    });

    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { wakeRecipient: true, kind: "cli-chat", conversationId: "cli-chat:cli:agent-a" },
    }));
    expect(text()).toContain("threaded answer");
    expect(text()).not.toContain("other mailbox traffic");
    expect(mockMarkAsRead).toHaveBeenCalledWith("thread-reply");
    expect(mockMarkAsRead).not.toHaveBeenCalledWith("other-thread");
  });
});

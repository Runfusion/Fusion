import { describe, expect, it, vi } from "vitest";
import { createReadMessagesTool } from "../agent-tools.js";

const message = {
  id: "msg-cli-chat",
  fromId: "cli",
  fromType: "user" as const,
  toId: "agent-001",
  toType: "agent" as const,
  content: "Hello from the CLI",
  type: "user-to-agent" as const,
  read: false,
  createdAt: "2026-07-20T12:00:00.000Z",
  updatedAt: "2026-07-20T12:00:00.000Z",
};

function createMessageStore(messages: Array<typeof message & { metadata?: Record<string, unknown> }>) {
  return {
    getInbox: vi.fn().mockResolvedValue(messages),
    getMessage: vi.fn(),
  };
}

describe("fn_read_messages conversation identity", () => {
  it("shows a mailbox conversation id when message metadata provides one", async () => {
    const store = createMessageStore([{ ...message, metadata: { conversationId: "cli-chat:cli:agent-001" } }]);
    const tool = createReadMessagesTool(store as any, "agent-001");

    const result = await tool.execute("call-1", {});

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("[conversation: cli-chat:cli:agent-001]"),
    });
  });

  it("does not add a conversation label for ordinary mailbox messages", async () => {
    const store = createMessageStore([message]);
    const tool = createReadMessagesTool(store as any, "agent-001");

    const result = await tool.execute("call-1", {});

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.not.stringContaining("[conversation:"),
    });
  });
});

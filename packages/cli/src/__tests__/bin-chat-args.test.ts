import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChatCliArgs } from "../commands/chat.js";

describe("fn chat argument parsing", () => {
  it("passes --conversation-id through from argv-shaped chat arguments", () => {
    expect(parseChatCliArgs(["agent-001", "hello", "--conversation-id", "custom-thread"])).toMatchObject({
      agentId: "agent-001",
      contentArg: "hello",
      once: true,
      nonInteractive: true,
      conversationId: "custom-thread",
    });
  });

  it("rejects a missing --conversation-id value instead of treating it as message content", () => {
    expect(parseChatCliArgs(["agent-001", "--conversation-id"])).toMatchObject({
      error: expect.stringContaining("Usage: fn chat"),
    });
    expect(parseChatCliArgs(["agent-001", "--conversation-id", "--once"])).toMatchObject({
      error: expect.stringContaining("Usage: fn chat"),
    });
    expect(parseChatCliArgs(["agent-001", "--conversation-id", "good", "--conversation-id"])).toMatchObject({
      error: expect.stringContaining("Usage: fn chat"),
    });
  });

  it("describes fn chat as agent inbox delivery in top-level help", () => {
    const source = readFileSync(resolve(__dirname, "../bin.ts"), "utf8");

    expect(source).toContain("Named mailbox conversation; delivers to agent inbox");
  });
});

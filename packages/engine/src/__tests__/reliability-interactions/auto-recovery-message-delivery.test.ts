import { describe, expect, it, vi } from "vitest";
import { createPostRoomMessageTool, createSendMessageTool } from "../../agent-tools.js";

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

describe("reliability interaction: message delivery auto-recovery", () => {
  it("recovers transient direct-message delivery and returns success", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("SQLITE_BUSY"), { code: "SQLITE_BUSY" }))
      .mockResolvedValue({ id: "m1" });
    const messageStore = { sendMessage } as any;
    const tool = createSendMessageTool(messageStore, "agent-a", { autoRecovery: { mode: "programmatic", maxRetries: 3 } as any });

    const result = await tool.execute("1", { to_id: "agent-b", content: "hello" } as any, undefined, undefined, {} as any);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(firstText(result as any)).toContain("Message sent to agent-b");
  });

  it("recovers transient room-message delivery and returns success", async () => {
    const addRoomMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({ id: "r-msg-1" });
    const chatStore = {
      listRoomMembers: vi.fn().mockReturnValue([{ agentId: "agent-a" }]),
      addRoomMessage,
    } as any;
    const tool = createPostRoomMessageTool(chatStore, "agent-a", { autoRecovery: { mode: "programmatic", maxRetries: 3 } as any });

    const result = await tool.execute("1", { roomId: "room-1", content: "hello" } as any, undefined, undefined, {} as any);
    expect(addRoomMessage).toHaveBeenCalledTimes(2);
    expect(firstText(result as any)).toContain("Room message posted");
  });

  it("preserves ERROR contract for permanent failures", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("recipient not found"));
    const messageStore = { sendMessage } as any;
    const tool = createSendMessageTool(messageStore, "agent-a", { autoRecovery: { mode: "programmatic", maxRetries: 3 } as any });

    const result = await tool.execute("1", { to_id: "agent-b", content: "hello" } as any, undefined, undefined, {} as any);
    expect(firstText(result as any)).toBe("ERROR: Failed to send message: recipient not found");
  });

  it("mode off preserves first-throw ERROR contract", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("SQLITE_BUSY"), { code: "SQLITE_BUSY" }));
    const messageStore = { sendMessage } as any;
    const tool = createSendMessageTool(messageStore, "agent-a", { autoRecovery: { mode: "off", maxRetries: 3 } as any });

    const result = await tool.execute("1", { to_id: "agent-b", content: "hello" } as any, undefined, undefined, {} as any);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstText(result as any)).toBe("ERROR: Failed to send message: SQLITE_BUSY");
  });
});

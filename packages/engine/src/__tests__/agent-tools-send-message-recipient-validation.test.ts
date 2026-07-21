import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createSendMessageTool } from "../agent-tools.js";

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

function createMessageStoreHarness(parent?: Record<string, unknown> | null) {
  const wakeSpy = vi.fn();
  const getMessage = vi.fn(async () => parent ?? null);
  const sendMessage = vi.fn(async (input: Record<string, unknown>) => {
    if (input.toType === "agent") {
      await wakeSpy(input);
    }
    return { id: "msg-1" };
  });
  return { messageStore: { getMessage, sendMessage }, getMessage, sendMessage, wakeSpy };
}

async function executeSend(
  tool: ReturnType<typeof createSendMessageTool>,
  params: Record<string, unknown>,
) {
  return tool.execute("1", params as never, undefined, undefined, {});
}

describe("createSendMessageTool recipient validation", () => {
  it("rejects a missing agent before persistence or wake", async () => {
    const { messageStore, sendMessage, wakeSpy } = createMessageStoreHarness();
    const agentStore = { getAgent: vi.fn().mockResolvedValue(null) };
    const tool = createSendMessageTool(messageStore as never, "agent-a", { agentStore: agentStore as never });

    const result = await executeSend(tool, { to_id: "agent-does-not-exist", content: "hello", type: "agent-to-agent" });

    expect(firstText(result as never)).toMatch(/^ERROR: Recipient agent 'agent-does-not-exist' does not exist/);
    expect(agentStore.getAgent).toHaveBeenCalledWith("agent-does-not-exist");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it("uses async getAgent and still sends and wakes an existing recipient", async () => {
    const { messageStore, sendMessage, wakeSpy } = createMessageStoreHarness();
    // Mimics PostgreSQL mode: only async getAgent is available; there is no sync cache.
    const agentStore = { getAgent: vi.fn().mockResolvedValue({ id: "agent-b" }) };
    const tool = createSendMessageTool(messageStore as never, "agent-a", { agentStore: agentStore as never });

    const result = await executeSend(tool, { to_id: "agent-b", content: "hello" });

    expect(firstText(result as never)).toContain("Message sent to agent-b");
    expect(agentStore.getAgent).toHaveBeenCalledWith("agent-b");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not resolve user recipients and preserves no-resolver behavior", async () => {
    const userHarness = createMessageStoreHarness();
    const agentStore = { getAgent: vi.fn() };
    const userTool = createSendMessageTool(userHarness.messageStore as never, "agent-a", { agentStore: agentStore as never });

    const userResult = await executeSend(userTool, { to_id: "dashboard-user", content: "hello", type: "agent-to-user" });

    expect(firstText(userResult as never)).toContain("Message sent to dashboard-user");
    expect(agentStore.getAgent).not.toHaveBeenCalled();
    expect(userHarness.sendMessage).toHaveBeenCalledTimes(1);

    const legacyHarness = createMessageStoreHarness();
    const legacyTool = createSendMessageTool(legacyHarness.messageStore as never, "agent-a");
    const legacyResult = await executeSend(legacyTool, { to_id: "unknown-agent", content: "hello" });
    expect(firstText(legacyResult as never)).toContain("Message sent to unknown-agent");
    expect(legacyHarness.sendMessage).toHaveBeenCalledTimes(1);

    expect(firstText(await executeSend(legacyTool, { to_id: "agent-b", content: " " }) as never)).toBe("ERROR: Message content cannot be empty");
    expect(firstText(await executeSend(legacyTool, { to_id: "agent-b", content: "hello", reply_to_message_id: " " }) as never)).toBe("ERROR: reply_to_message_id must be a non-empty string");
  });

  it("routes an owned CLI parent reply to the CLI user mailbox", async () => {
    const parent = {
      id: "parent-cli",
      fromId: "cli",
      fromType: "user",
      toId: "agent-a",
      toType: "agent",
    };
    const { messageStore, sendMessage } = createMessageStoreHarness(parent);
    const tool = createSendMessageTool(messageStore as never, "agent-a");

    // Heartbeat guidance intentionally names the sender explicitly; it must still
    // preserve the parent user's type rather than treating `cli` as an agent.
    const result = await executeSend(tool, { content: "received", reply_to_message_id: "parent-cli", to_id: "cli" });

    expect(firstText(result as never)).toContain("Message sent to cli");
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      toId: "cli",
      toType: "user",
      type: "agent-to-user",
      metadata: { replyTo: { messageId: "parent-cli" } },
    }));
  });

  it("routes an owned dashboard parent reply to the dashboard mailbox", async () => {
    const parent = {
      id: "parent-dashboard",
      fromId: "dashboard",
      fromType: "user",
      toId: "agent-a",
      toType: "agent",
    };
    const { messageStore, sendMessage } = createMessageStoreHarness(parent);
    const tool = createSendMessageTool(messageStore as never, "agent-a");

    await executeSend(tool, { content: "received", reply_to_message_id: "parent-dashboard" });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      toId: "dashboard",
      toType: "user",
      type: "agent-to-user",
    }));
  });

  it("allows an explicit alternate recipient without inheriting a foreign parent", async () => {
    const foreignParent = {
      id: "parent-foreign",
      fromId: "cli",
      fromType: "user",
      toId: "agent-b",
      toType: "agent",
    };
    const { messageStore, sendMessage } = createMessageStoreHarness(foreignParent);
    const tool = createSendMessageTool(messageStore as never, "agent-a");

    await executeSend(tool, { content: "forward", reply_to_message_id: "parent-foreign", to_id: "agent-c" });

    // A different explicit ID is a forward: without type it keeps the legacy
    // agent-to-agent default instead of inheriting the foreign parent's user type.
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ toId: "agent-c", toType: "agent", type: "agent-to-agent" }));
  });

  it("rejects foreign or missing parents when no explicit recipient is supplied", async () => {
    const foreignParent = {
      id: "parent-foreign",
      fromId: "cli",
      fromType: "user",
      toId: "agent-b",
      toType: "agent",
    };
    const foreignHarness = createMessageStoreHarness(foreignParent);
    const foreignTool = createSendMessageTool(foreignHarness.messageStore as never, "agent-a");
    const missingHarness = createMessageStoreHarness();
    const missingTool = createSendMessageTool(missingHarness.messageStore as never, "agent-a");

    expect(firstText(await executeSend(foreignTool, { content: "nope", reply_to_message_id: "parent-foreign" }) as never)).toMatch(/^ERROR: reply_to_message_id/);
    expect(foreignHarness.sendMessage).not.toHaveBeenCalled();
    expect(firstText(await executeSend(missingTool, { content: "nope", reply_to_message_id: "missing" }) as never)).toMatch(/^ERROR: reply_to_message_id/);
    expect(missingHarness.sendMessage).not.toHaveBeenCalled();
  });

  it("does not report delivery when recipient validation is unavailable", async () => {
    const failedLookupHarness = createMessageStoreHarness();
    const failedLookupTool = createSendMessageTool(failedLookupHarness.messageStore as never, "agent-a", {
      agentStore: { getAgent: vi.fn().mockRejectedValue(new Error("database unavailable")) } as never,
    });

    const result = await executeSend(failedLookupTool, { to_id: "agent-b", content: "hello" });
    expect(firstText(result as never)).toMatch(/^ERROR: Recipient agent 'agent-b' could not be validated/);
    expect(failedLookupHarness.sendMessage).not.toHaveBeenCalled();
    expect(failedLookupHarness.wakeSpy).not.toHaveBeenCalled();
  });

  it("rejects an undefined recipient lookup result", async () => {
    const { messageStore, sendMessage, wakeSpy } = createMessageStoreHarness();
    const tool = createSendMessageTool(messageStore as never, "agent-a", {
      agentStore: { getAgent: vi.fn().mockResolvedValue(undefined) } as never,
    });

    const result = await executeSend(tool, { to_id: "agent-does-not-exist", content: "hello" });
    expect(firstText(result as never)).toMatch(/^ERROR: Recipient agent 'agent-does-not-exist' does not exist/);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wakeSpy).not.toHaveBeenCalled();
  });
});

describe("send-message registration wiring", () => {
  it("forwards the in-scope AgentStore at every engine registration", async () => {
    const [executor, stepSessionExecutor, heartbeat] = await Promise.all([
      readFile(fileURLToPath(new URL("../executor.ts", import.meta.url)), "utf8"),
      readFile(fileURLToPath(new URL("../step-session-executor.ts", import.meta.url)), "utf8"),
      readFile(fileURLToPath(new URL("../agent-heartbeat.ts", import.meta.url)), "utf8"),
    ]);

    expect(executor).toContain("createSendMessageTool(this.options.messageStore, assignedAgentId, { autoRecovery: settings.autoRecovery, runAudit: audit, taskStore: this.store, settings, agentStore: this.options.agentStore })");
    expect(stepSessionExecutor).toContain("createSendMessageTool(this.options.messageStore, taskDetail.assignedAgentId, { autoRecovery: settings.autoRecovery, taskStore: this.options.store!, settings, agentStore: this.options.agentStore })");
    expect(heartbeat.match(/createSendMessageTool\(this\.messageStore, agentId, \{ agentStore: this\.store \}\)/g)).toHaveLength(1);
    expect(heartbeat.match(/createSendMessageTool\(messageStore, agentId, \{ agentStore: this\.store \}\)/g)).toHaveLength(1);
  });
});

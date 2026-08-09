import { beforeEach, describe, expect, it, vi } from "vitest";

const { emitUsageEvent, sendMessage } = vi.hoisted(() => ({
  emitUsageEvent: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../task-store/async/async-events.js", () => ({ emitUsageEvent }));
vi.mock("../async-stores/async-message-store.js", () => ({ sendMessage }));

import { MessageStore } from "../stores/message-store.js";

/**
 * FNXC:CommandCenterActivity 2026-08-09-10:46:
 * Mailbox telemetry is a post-persist, fail-soft side effect. These tests pin that human content
 * never reaches usage metadata and a telemetry failure cannot alter the delivered message.
 */
describe("MessageStore user-message telemetry", () => {
  const layer = { db: {}, projectId: "project-1" } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    sendMessage.mockResolvedValue(undefined);
    emitUsageEvent.mockResolvedValue(true);
  });

  it("emits one content-free mailbox event for a human sender addressed to an agent", async () => {
    const store = new MessageStore(null, { asyncLayer: layer });
    const message = await store.sendMessage({
      fromId: "user-1", fromType: "user", toId: "agent-1", toType: "agent",
      content: "private mailbox text", type: "user-to-agent", metadata: { taskId: "FN-8868" },
    });

    expect(emitUsageEvent).toHaveBeenCalledWith(layer.db, "project-1", {
      kind: "user_message", agentId: "agent-1", taskId: "FN-8868", category: "mailbox",
    });
    expect(JSON.stringify(emitUsageEvent.mock.calls[0])).not.toContain("private mailbox text");
    expect(message.content).toBe("private mailbox text");
  });

  it("emits a null-agent mailbox event for a human recipient and propagates no content", async () => {
    const store = new MessageStore(null, { asyncLayer: layer });
    await store.sendMessage({ fromId: "user-1", fromType: "user", toId: "user-2", toType: "user", content: "human text", type: "agent-to-user" });
    expect(emitUsageEvent).toHaveBeenCalledWith(layer.db, "project-1", {
      kind: "user_message", agentId: null, taskId: null, category: "mailbox",
    });
    expect(JSON.stringify(emitUsageEvent.mock.calls[0])).not.toContain("human text");
  });

  it("leaves delivery successful when telemetry rejects and skips non-human senders", async () => {
    emitUsageEvent.mockRejectedValueOnce(new Error("telemetry unavailable"));
    const store = new MessageStore(null, { asyncLayer: layer });

    await expect(store.sendMessage({
      fromId: "user-1", fromType: "user", toId: "user-2", toType: "user",
      content: "human text", type: "agent-to-user",
    })).resolves.toMatchObject({ content: "human text" });
    await Promise.resolve();
    expect(emitUsageEvent).toHaveBeenCalledWith(layer.db, "project-1", {
      kind: "user_message", agentId: null, taskId: null, category: "mailbox",
    });

    await store.sendMessage({ fromId: "agent-1", fromType: "agent", toId: "agent-2", toType: "agent", content: "agent text", type: "agent-to-agent" });
    await store.sendMessage({ fromId: "system", fromType: "system", toId: "agent-2", toType: "agent", content: "system text", type: "system" });
    expect(emitUsageEvent).toHaveBeenCalledTimes(1);
  });

  it("leaves delivery successful when telemetry throws synchronously", async () => {
    emitUsageEvent.mockImplementationOnce(() => { throw new Error("telemetry unavailable"); });
    const store = new MessageStore(null, { asyncLayer: layer });
    await expect(store.sendMessage({ fromId: "user-1", fromType: "user", toId: "agent-1", toType: "agent", content: "delivered", type: "user-to-agent" })).resolves.toMatchObject({ content: "delivered" });
  });
});

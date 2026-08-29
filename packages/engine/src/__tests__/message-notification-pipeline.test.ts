import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Message, MessageType, Settings } from "@fusion/core";
import { NotificationService } from "../notification/notification-service.js";

class TestMessageStore extends EventEmitter {
  private counter = 0;

  sendMessage(type: MessageType, content: string): Message {
    this.counter += 1;
    const message: Message = {
      id: `msg-${this.counter}`,
      fromId: type === "user-to-agent" ? "user-1" : "agent-1",
      fromType: type === "user-to-agent" ? "user" : "agent",
      toId: type === "agent-to-agent" ? "agent-2" : "user-1",
      toType: type === "agent-to-agent" ? "agent" : "user",
      content,
      type,
      read: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.emit("message:sent", message);
    return message;
  }
}

function createStore(settings: Partial<Settings> = {}) {
  return {
    getSettings: vi.fn(async () => ({ ntfyEnabled: true, ntfyTopic: "test-topic", ...settings }) as Settings),
    on: vi.fn(),
    off: vi.fn(),
  };
}

describe("message notification pipeline", () => {
  it("dispatches agent-originated messages and ignores user-to-agent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const store = createStore({
      ntfyEvents: ["message:agent-to-user", "message:agent-to-agent"],
      ntfyAccessToken: "token-123",
    });
    const messageStore = new TestMessageStore();

    const service = new NotificationService(store as any, {
      messageStore: messageStore as any,
      agentNameResolver: (agentId) => (agentId === "agent-1" ? "Triage Bot" : "Executor Bot"),
    });
    await service.start();

    messageStore.sendMessage("agent-to-user", "hi");
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://ntfy.sh/");
    const firstRequest = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const firstHeaders = firstRequest.headers as Record<string, string>;
    expect(firstHeaders["Content-Type"]).toBe("application/json");
    expect(firstHeaders.Authorization).toBe("Bearer token-123");
    const firstBody = JSON.parse(String(firstRequest.body)) as { title: string; message: string; topic: string };
    expect(firstBody.topic).toBe("test-topic");
    expect(firstBody.title).toContain("Triage Bot");
    expect(firstBody.message).toContain("hi");

    messageStore.sendMessage("agent-to-agent", "relay");
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://ntfy.sh/");
    const secondBody = JSON.parse(String((fetchSpy.mock.calls[1]?.[1] as RequestInit).body)) as { title: string; message: string };
    expect(secondBody.title).toContain("Triage Bot → Executor Bot");
    expect(secondBody.message).toContain("relay");

    messageStore.sendMessage("user-to-agent", "ignore me");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await service.stop();
    fetchSpy.mockRestore();
  });
});

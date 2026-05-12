import { beforeEach, describe, expect, it, vi } from "vitest";

import { WebhookNotificationProvider } from "../notification/webhook-provider.js";

describe("WebhookNotificationProvider", () => {
  let provider: WebhookNotificationProvider;
  const fetchMock = vi.fn();

  beforeEach(() => {
    provider = new WebhookNotificationProvider();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("getProviderId returns webhook", () => {
    expect(provider.getProviderId()).toBe("webhook");
  });

  it("initialize stores config", async () => {
    await expect(
      provider.initialize({
        webhookUrl: "https://example.com/hook",
        webhookFormat: "slack",
        events: ["in-review"],
      }),
    ).resolves.toBeUndefined();

    expect(provider.isEventSupported("in-review")).toBe(true);
    expect(provider.isEventSupported("failed")).toBe(false);
  });

  it("initialize rejects missing URL", async () => {
    await expect(provider.initialize({ webhookFormat: "slack" })).rejects.toThrow("webhookUrl is required");
  });

  it("sendNotification formats Slack correctly", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    await provider.initialize({ webhookUrl: "https://example.com/hook", webhookFormat: "slack" });

    await provider.sendNotification("in-review", { taskId: "FN-1", taskTitle: "My Task", event: "in-review" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body));
    expect(body.text).toContain("My Task");
  });

  it("sendNotification formats Discord correctly", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    await provider.initialize({ webhookUrl: "https://example.com/hook", webhookFormat: "discord" });

    await provider.sendNotification("in-review", { taskId: "FN-1", taskTitle: "My Task", event: "in-review" });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body));
    expect(body.content).toContain("My Task");
  });

  it("sendNotification formats Generic correctly", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    await provider.initialize({
      webhookUrl: "https://example.com/hook",
      webhookFormat: "generic",
      dashboardHost: "http://dash",
      projectId: "p1",
    });

    await provider.sendNotification("message:agent-to-user", {
      taskId: "FN-1",
      taskTitle: "My Task",
      event: "message:agent-to-user",
      metadata: {
        messageId: "msg-1",
        fromId: "agent-1",
        toId: "user:dashboard",
        fromName: "Triage Bot",
        toName: "Dashboard User",
        preview: "hello",
      },
    });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(requestInit.body));
    expect(payload.event).toBe("message:agent-to-user");
    expect(payload.timestamp).toEqual(expect.any(String));
    expect(payload.task).toEqual({ id: "FN-1", title: "My Task" });
    expect(payload.metadata).toEqual(
      expect.objectContaining({
        messageId: "msg-1",
        fromId: "agent-1",
        toId: "user:dashboard",
        fromName: "Triage Bot",
        toName: "Dashboard User",
      }),
    );
    expect(payload.clickUrl).toBe("http://dash/?project=p1&task=FN-1#message-msg-1");
  });

  it("sendNotification returns success on HTTP 200", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    await provider.initialize({ webhookUrl: "https://example.com/hook", webhookFormat: "generic" });

    await expect(
      provider.sendNotification("in-review", { taskId: "FN-1", taskTitle: "My Task", event: "in-review" }),
    ).resolves.toEqual({ success: true, providerId: "webhook" });
  });

  it("sendNotification returns failure on HTTP error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });
    await provider.initialize({ webhookUrl: "https://example.com/hook", webhookFormat: "generic" });

    await expect(
      provider.sendNotification("in-review", { taskId: "FN-1", taskTitle: "My Task", event: "in-review" }),
    ).resolves.toEqual({ success: false, providerId: "webhook", error: expect.stringContaining("500") });
  });

  it("sendNotification returns failure on network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("network error"));
    await provider.initialize({ webhookUrl: "https://example.com/hook", webhookFormat: "generic" });

    await expect(
      provider.sendNotification("in-review", { taskId: "FN-1", taskTitle: "My Task", event: "in-review" }),
    ).resolves.toEqual({ success: false, providerId: "webhook", error: expect.any(String) });
  });

  it("isEventSupported returns true when no filter", async () => {
    await provider.initialize({ webhookUrl: "https://example.com/hook", webhookFormat: "generic", events: [] });
    expect(provider.isEventSupported("in-review")).toBe(true);
    expect(provider.isEventSupported("custom-event")).toBe(true);
  });

  it("isEventSupported filters by configured events", async () => {
    await provider.initialize({
      webhookUrl: "https://example.com/hook",
      webhookFormat: "generic",
      events: ["in-review", "merged"],
    });

    expect(provider.isEventSupported("in-review")).toBe(true);
    expect(provider.isEventSupported("failed")).toBe(false);
  });

  it("shutdown aborts requests", async () => {
    await provider.initialize({ webhookUrl: "https://example.com/hook", webhookFormat: "generic" });
    await provider.shutdown();

    await expect(
      provider.sendNotification("in-review", { taskId: "FN-1", taskTitle: "My Task", event: "in-review" }),
    ).resolves.toEqual({ success: false, providerId: "webhook", error: "Not initialized" });
  });

  it.each([
    ["in-review", "ready for review"],
    ["merged", "has been merged to main"],
    ["failed", "has failed and needs attention"],
    ["awaiting-approval", "needs your approval before it can proceed"],
    ["awaiting-user-review", "needs human review before it can proceed"],
    ["planning-awaiting-input", "is awaiting your input during planning"],
    ["gridlock", "Pipeline gridlocked"],
    ["fallback-used", "Fusion recovered by switching from"],
    ["message:agent-to-user", "From: Triage Bot → You: hello"],
    ["message:agent-to-agent", "From: Triage Bot → To: Executor Bot: hello"],
    ["message:room", "In #Incident Room: Triage Bot: hello"],
    ["unknown-event", 'Event "unknown-event" for task My Task'],
  ])("message formatting for %s", async (event, expectedPart) => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    await provider.initialize({ webhookUrl: "https://example.com/hook", webhookFormat: "slack" });

    await provider.sendNotification(event, {
      taskId: "FN-1",
      taskTitle: "My Task",
      event,
      metadata: {
        fromId: "agent-1",
        toId: "agent-2",
        fromName: "Triage Bot",
        toName: "Executor Bot",
        senderAgentId: "agent-1",
        senderName: "Triage Bot",
        roomId: "room-1",
        roomName: "Incident Room",
        preview: "hello",
      },
    });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body));
    expect(body.text).toContain(expectedPart);
  });

  it("includes room metadata and room deep link for room notifications", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    await provider.initialize({
      webhookUrl: "https://example.com/hook",
      webhookFormat: "generic",
      dashboardHost: "http://dash",
      projectId: "p1",
    });

    await provider.sendNotification("message:room", {
      event: "message:room",
      metadata: {
        messageId: "msg-room",
        roomId: "room-1",
        roomName: "Incident Room",
        senderAgentId: "agent-1",
        senderName: "Triage Bot",
        preview: "hello",
      },
    });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(requestInit.body));
    expect(payload.metadata).toEqual(
      expect.objectContaining({
        roomId: "room-1",
        roomName: "Incident Room",
        senderAgentId: "agent-1",
        senderName: "Triage Bot",
      }),
    );
    expect(payload.clickUrl).toBe("http://dash/?project=p1&view=rooms&room=room-1#message-msg-room");
  });

  it("title fallback uses taskId and truncated description snippet", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    await provider.initialize({ webhookUrl: "https://example.com/hook", webhookFormat: "slack" });

    const description = "a".repeat(220);
    await provider.sendNotification("failed", { taskId: "FN-1", taskDescription: description, event: "failed" });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body));
    expect(body.text).toContain('Task "FN-1:');
    expect(body.text).toContain("...");
  });
});

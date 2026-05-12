import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendNtfyNotificationWithResult: vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK' })),
  buildNtfyClickUrl: vi.fn(() => "http://dash/?project=p1&task=FN-1"),
}));

vi.mock("../notifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../notifier.js")>();
  return {
    ...actual,
    sendNtfyNotificationWithResult: mocks.sendNtfyNotificationWithResult,
    buildNtfyClickUrl: mocks.buildNtfyClickUrl,
  };
});

import { NtfyNotificationProvider, resolveParticipantLabel } from "../notification/ntfy-provider.js";

describe("NtfyNotificationProvider", () => {
  let provider: NtfyNotificationProvider;

  beforeEach(async () => {
    mocks.sendNtfyNotificationWithResult.mockClear();
    mocks.buildNtfyClickUrl.mockClear();
    provider = new NtfyNotificationProvider();
    await provider.initialize({
      topic: "topic-a",
      ntfyBaseUrl: "https://ntfy.local",
      ntfyAccessToken: "secret-token",
      dashboardHost: "http://dash",
      projectId: "p1",
    });
  });

  it("returns provider id", () => {
    expect(provider.getProviderId()).toBe("ntfy");
  });

  it.each([
    ["in-review", "Task FN-1 completed", "is ready for review", "default"],
    ["merged", "Task FN-1 merged", "has been merged to main", "default"],
    ["failed", "Task FN-1 failed", "has failed and needs attention", "high"],
    ["awaiting-approval", "Plan needs approval for FN-1", "needs your approval", "high"],
    ["awaiting-user-review", "User review needed for FN-1", "needs human review", "high"],
    ["planning-awaiting-input", "Planning input needed for FN-1", "awaiting your input", "high"],
    ["fallback-used", "Fallback model used for FN-1", "switched from", "high"],
    ["message:agent-to-user", "New message from Triage Bot", "Triage Bot → you: preview text", "high"],
    ["message:agent-to-agent", "Triage Bot → Executor Bot", "Triage Bot messaged Executor Bot: preview text", "default"],
    ["message:room", "#Incident Room — Triage Bot", "Triage Bot in #Incident Room: preview text", "default"],
  ])("maps %s event correctly", async (event, expectedTitle, messagePart, priority) => {
    await provider.sendNotification(event as any, {
      taskId: "FN-1",
      taskTitle: "T",
      event: event as any,
      metadata: {
        fromId: "agent-1",
        toId: "agent-2",
        fromName: "Triage Bot",
        toName: "Executor Bot",
        senderAgentId: "agent-1",
        senderName: "Triage Bot",
        preview: "preview text",
        messageId: "msg-1",
        roomId: "room-1",
        roomName: "Incident Room",
      },
    });

    expect(mocks.sendNtfyNotificationWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "topic-a",
        ntfyAccessToken: "secret-token",
        title: expectedTitle,
        priority,
        message: expect.stringContaining(messagePart),
      }),
    );
  });

  it("resolveParticipantLabel prefers names and falls back to ids", () => {
    expect(resolveParticipantLabel({ fromName: "Triage Bot", fromId: "agent-1" }, "from")).toBe("Triage Bot");
    expect(resolveParticipantLabel({ toId: "agent-2" }, "to")).toBe("agent-2");
  });

  it("supports known events and rejects unknown", () => {
    expect(provider.isEventSupported("in-review" as any)).toBe(true);
    expect(provider.isEventSupported("merged" as any)).toBe(true);
    expect(provider.isEventSupported("failed" as any)).toBe(true);
    expect(provider.isEventSupported("awaiting-approval" as any)).toBe(true);
    expect(provider.isEventSupported("awaiting-user-review" as any)).toBe(true);
    expect(provider.isEventSupported("planning-awaiting-input" as any)).toBe(true);
    expect(provider.isEventSupported("fallback-used" as any)).toBe(true);
    expect(provider.isEventSupported("message:agent-to-user" as any)).toBe(true);
    expect(provider.isEventSupported("message:agent-to-agent" as any)).toBe(true);
    expect(provider.isEventSupported("message:room" as any)).toBe(true);
    expect(provider.isEventSupported("custom-event" as any)).toBe(false);
  });

  it("shutdown aborts internal AbortController", async () => {
    await provider.shutdown();
    await provider.sendNotification("in-review" as any, { taskId: "FN-1", taskTitle: "T", event: "in-review" as any });
    expect(mocks.sendNtfyNotificationWithResult).toHaveBeenCalledWith(expect.objectContaining({ signal: undefined }));
  });

  it("uses fallback identifier from id+description when no title", async () => {
    await provider.sendNotification("failed" as any, {
      taskId: "FN-1",
      taskDescription: "desc",
      event: "failed" as any,
    });

    expect(mocks.sendNtfyNotificationWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Task "FN-1: desc"') }),
    );
  });

  it("builds click URL from config for task message events", async () => {
    await provider.sendNotification("message:agent-to-user" as any, {
      taskId: "FN-1",
      taskTitle: "T",
      event: "message:agent-to-user" as any,
      metadata: { messageId: "msg-1", fromId: "agent-1", preview: "hello" },
    });
    expect(mocks.buildNtfyClickUrl).toHaveBeenCalledWith({
      dashboardHost: "http://dash",
      projectId: "p1",
      taskId: "FN-1",
      messageId: "msg-1",
      view: "mailbox",
    });
  });

  it("uses room deep link for room notifications", async () => {
    await provider.sendNotification("message:room" as any, {
      event: "message:room" as any,
      metadata: {
        messageId: "msg-room",
        roomId: "room-1",
        roomName: "Incident Room",
        senderAgentId: "agent-1",
        senderName: "Triage Bot",
        preview: "hello",
      },
    });

    expect(mocks.buildNtfyClickUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-1",
        messageId: "msg-room",
        view: "rooms",
      }),
    );
  });

  it("uses mailbox deep link when message is not task-bound", async () => {
    await provider.sendNotification("message:agent-to-agent" as any, {
      event: "message:agent-to-agent" as any,
      metadata: { messageId: "msg-2", fromId: "agent-1", toId: "agent-2", preview: "hello" },
    });

    expect(mocks.buildNtfyClickUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: undefined,
        messageId: "msg-2",
        view: "mailbox",
      }),
    );
  });

  it("passes unicode mailbox content through verbatim for agent-to-user notifications", async () => {
    await provider.sendNotification("message:agent-to-user" as any, {
      taskId: "FN-1",
      taskTitle: "T",
      event: "message:agent-to-user" as any,
      metadata: {
        messageId: "msg-1",
        fromId: "agent-1",
        fromName: "Triage Bot",
        preview: "preview text",
      },
    });

    expect(mocks.sendNtfyNotificationWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "New message from Triage Bot",
        message: "Triage Bot → you: preview text",
      }),
    );
  });

  it("passes unicode mailbox content through verbatim for agent-to-agent notifications", async () => {
    await provider.sendNotification("message:agent-to-agent" as any, {
      event: "message:agent-to-agent" as any,
      metadata: {
        messageId: "msg-2",
        fromId: "agent-1",
        toId: "agent-2",
        fromName: "Triage Bot",
        toName: "Executor Bot",
        preview: "preview text",
      },
    });

    expect(mocks.sendNtfyNotificationWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Triage Bot → Executor Bot",
        message: "Triage Bot messaged Executor Bot: preview text",
      }),
    );
  });

  it("uses Re: title for agent-to-agent replies", async () => {
    await provider.sendNotification("message:agent-to-agent" as any, {
      event: "message:agent-to-agent" as any,
      metadata: {
        messageId: "msg-3",
        fromId: "agent-1",
        toId: "agent-2",
        preview: "reply preview",
        replyToMessageId: "msg-1",
      },
    });

    expect(mocks.sendNtfyNotificationWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Re: reply preview",
      }),
    );
  });
});

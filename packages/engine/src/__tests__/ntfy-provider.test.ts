import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendNtfyNotification: vi.fn(async () => undefined),
  buildNtfyClickUrl: vi.fn(() => "http://dash/?project=p1&task=FN-1"),
}));

vi.mock("../notifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../notifier.js")>();
  return {
    ...actual,
    sendNtfyNotification: mocks.sendNtfyNotification,
    buildNtfyClickUrl: mocks.buildNtfyClickUrl,
  };
});

import { NtfyNotificationProvider } from "../notification/ntfy-provider.js";

describe("NtfyNotificationProvider", () => {
  let provider: NtfyNotificationProvider;

  beforeEach(async () => {
    mocks.sendNtfyNotification.mockClear();
    mocks.buildNtfyClickUrl.mockClear();
    provider = new NtfyNotificationProvider();
    await provider.initialize({
      topic: "topic-a",
      ntfyBaseUrl: "https://ntfy.local",
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
  ])("maps %s event correctly", async (event, expectedTitle, messagePart, priority) => {
    await provider.sendNotification(event as any, { taskId: "FN-1", taskTitle: "T", event: event as any });

    expect(mocks.sendNtfyNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "topic-a",
        title: expectedTitle,
        priority,
        message: expect.stringContaining(messagePart),
      }),
    );
  });

  it("supports known events and rejects unknown", () => {
    expect(provider.isEventSupported("in-review" as any)).toBe(true);
    expect(provider.isEventSupported("merged" as any)).toBe(true);
    expect(provider.isEventSupported("failed" as any)).toBe(true);
    expect(provider.isEventSupported("awaiting-approval" as any)).toBe(true);
    expect(provider.isEventSupported("awaiting-user-review" as any)).toBe(true);
    expect(provider.isEventSupported("planning-awaiting-input" as any)).toBe(true);
    expect(provider.isEventSupported("custom-event" as any)).toBe(false);
  });

  it("shutdown aborts internal AbortController", async () => {
    await provider.shutdown();
    await provider.sendNotification("in-review" as any, { taskId: "FN-1", taskTitle: "T", event: "in-review" as any });
    expect(mocks.sendNtfyNotification).toHaveBeenCalledWith(expect.objectContaining({ signal: undefined }));
  });

  it("uses fallback identifier from id+description when no title", async () => {
    await provider.sendNotification("failed" as any, {
      taskId: "FN-1",
      taskDescription: "desc",
      event: "failed" as any,
    });

    expect(mocks.sendNtfyNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Task "FN-1: desc"') }),
    );
  });

  it("builds click URL from config", async () => {
    await provider.sendNotification("merged" as any, { taskId: "FN-1", taskTitle: "T", event: "merged" as any });
    expect(mocks.buildNtfyClickUrl).toHaveBeenCalledWith({
      dashboardHost: "http://dash",
      projectId: "p1",
      taskId: "FN-1",
    });
  });
});

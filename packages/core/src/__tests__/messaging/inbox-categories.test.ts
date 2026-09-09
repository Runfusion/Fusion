import { describe, expect, it } from "vitest";
import {
  TASK_RECOMMENDATION_NOTICE_KIND,
  classifyDashboardInboxMessage,
  isDashboardInboxCategory,
} from "../../messaging/inbox-categories.js";
import { MessageStore } from "../../stores/message-store.js";
import type { MessageMetadata } from "../../types/messaging/messages.js";

describe("dashboard inbox categories", () => {
  it("classifies absent metadata as an ordinary message", () => {
    expect(classifyDashboardInboxMessage()).toBe("message");
  });

  it("keeps messages with any present non-recommendation kind in the ordinary inbox", () => {
    expect(classifyDashboardInboxMessage({ kind: "task-proposal", artifactId: "artifact-1" })).toBe("message");
    const explicitNullKind = { kind: null, artifactId: "artifact-1" } as unknown as MessageMetadata;
    expect(classifyDashboardInboxMessage(explicitNullKind)).toBe("message");
  });

  it("keeps blank and non-string artifact identifiers in the ordinary inbox", () => {
    expect(classifyDashboardInboxMessage({ artifactId: "   " })).toBe("message");
    expect(classifyDashboardInboxMessage({ artifactId: null })).toBe("message");
    expect(classifyDashboardInboxMessage({ artifactId: 123 })).toBe("message");
  });

  it.each(["report", "approval"] as const)("keeps %s structural mail in the ordinary inbox", (mailKind) => {
    expect(classifyDashboardInboxMessage({ mailKind, artifactId: "artifact-1" })).toBe("message");
  });

  it("routes recommendation and artifact notices to their dedicated destinations", () => {
    expect(classifyDashboardInboxMessage({ kind: TASK_RECOMMENDATION_NOTICE_KIND })).toBe("recommendation");
    expect(classifyDashboardInboxMessage({ artifactId: " artifact-1 " })).toBe("artifact");
  });

  it("recognizes only canonical categories", () => {
    expect(isDashboardInboxCategory("message")).toBe(true);
    expect(isDashboardInboxCategory("recommendation")).toBe(true);
    expect(isDashboardInboxCategory("artifact")).toBe(true);
    expect(isDashboardInboxCategory("unknown")).toBe(false);
    expect(isDashboardInboxCategory(undefined)).toBe(false);
  });

  it("rejects category operations explicitly without the PostgreSQL backend", async () => {
    const legacyStore = Object.create(MessageStore.prototype) as MessageStore;

    await expect(legacyStore.getInbox("dashboard", "user", { category: "message" }))
      .rejects.toThrow("Dashboard inbox categories require the PostgreSQL backend");
    await expect(legacyStore.markAllAsRead("dashboard", "user", "artifact"))
      .rejects.toThrow("Dashboard inbox categories require the PostgreSQL backend");
    await expect(legacyStore.getDashboardInboxCategoryCounts("dashboard", "user"))
      .rejects.toThrow("Dashboard inbox categories require the PostgreSQL backend");
  });
});

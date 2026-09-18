import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";

import { archiveAsGhostBug } from "../self-healing/archive-ghost-bug.js";

const decision = {
  decision: "archive" as const,
  reason: "all_cited_constructs_missing_on_main",
  findings: [
    { construct: { kind: "identifier" as const, raw: "Example.Missing" }, matched: false },
  ],
};

function createStore() {
  return {
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordActivity: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("archiveAsGhostBug visibility", () => {
  it("emits bounded audit metadata and an idempotent inbox message before archiving", async () => {
    const store = createStore();
    const messageStore = { sendMessageOnce: vi.fn().mockResolvedValue(undefined) };
    await archiveAsGhostBug(store, "FN-9271", "Fix valid task deletion", decision, { messageStore });

    await vi.waitFor(() => expect(store.recordRunAuditEvent).toHaveBeenCalled());
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-9271",
      agentId: "triage",
      mutationType: "task:auto-archived-ghost-bug-visibility",
      metadata: expect.objectContaining({
        taskId: "FN-9271",
        reason: "all_cited_constructs_missing_on_main",
        constructCount: 1,
        definitiveCount: 1,
        missingCount: 1,
        controlOutcome: "matched",
      }),
    }));
    const audit = vi.mocked(store.recordRunAuditEvent).mock.calls[0][0];
    expect(JSON.stringify(audit.metadata)).not.toContain("Example.Missing");

    expect(messageStore.sendMessageOnce).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("FN-9271"),
    }), "ghost-bug-archive:FN-9271");
    expect(messageStore.sendMessageOnce.mock.calls[0][0].content).toContain(decision.reason);
    expect(store.moveTask).toHaveBeenCalled();
  });

  it.each([
    undefined,
    { sendMessageOnce: vi.fn().mockImplementation(() => { throw new Error("mail unavailable"); }) },
    { sendMessageOnce: vi.fn().mockRejectedValue(new Error("mail unavailable")) },
  ])("archives when mailbox delivery is unavailable", async (messageStore) => {
    const store = createStore();
    await archiveAsGhostBug(store, "FN-9271", "Title", decision, { messageStore });
    expect(store.moveTask).toHaveBeenCalled();
  });

  it("archives when the audit sink throws", async () => {
    const store = createStore();
    vi.mocked(store.recordRunAuditEvent).mockImplementation(() => { throw new Error("audit unavailable"); });
    await archiveAsGhostBug(store, "FN-9271", "Title", decision);
    expect(store.moveTask).toHaveBeenCalled();
  });

  it("archives without waiting for a hanging mailbox delivery", async () => {
    const store = createStore();
    const messageStore = { sendMessageOnce: vi.fn().mockImplementation(() => new Promise<void>(() => undefined)) };
    await archiveAsGhostBug(store, "FN-9271", "Title", decision, { messageStore });
    expect(messageStore.sendMessageOnce).toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalled();
  });

  it("archives without waiting for a hanging audit sink", async () => {
    const store = createStore();
    vi.mocked(store.recordRunAuditEvent).mockImplementation(() => new Promise<void>(() => undefined));
    await archiveAsGhostBug(store, "FN-9271", "Title", decision);
    expect(store.moveTask).toHaveBeenCalled();
  });
});

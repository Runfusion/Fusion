import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";

import { softDeleteAsGhostBug } from "../self-healing/delete-ghost-bug.js";

const decision = {
  decision: "delete" as const,
  reason: "all_cited_constructs_missing_on_main",
  findings: [
    { construct: { kind: "identifier" as const, raw: "Example.Missing" }, matched: false },
  ],
};

function createStore() {
  return {
    logEntry: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("softDeleteAsGhostBug visibility", () => {
  it("emits bounded audit metadata and an idempotent inbox message before deletion", async () => {
    const store = createStore();
    const messageStore = { sendMessageOnce: vi.fn().mockResolvedValue(undefined) };
    await softDeleteAsGhostBug(store, "FN-9271", decision, { messageStore, taskTitle: "Fix valid task deletion" });
    await vi.waitFor(() => expect(store.recordRunAuditEvent).toHaveBeenCalled());
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-9271",
      agentId: "triage",
      mutationType: "task:auto-deleted-ghost-bug",
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
    }), "ghost-bug-delete:FN-9271");
    expect(messageStore.sendMessageOnce.mock.calls[0][0].content).toContain(decision.reason);
    expect(store.deleteTask).toHaveBeenCalledWith("FN-9271", { allowResurrection: false });
  });

  it.each([
    undefined,
    { sendMessageOnce: vi.fn().mockImplementation(() => { throw new Error("mail unavailable"); }) },
    { sendMessageOnce: vi.fn().mockRejectedValue(new Error("mail unavailable")) },
  ])("deletes when mailbox delivery is unavailable", async (messageStore) => {
    const store = createStore();
    await softDeleteAsGhostBug(store, "FN-9271", decision, { messageStore });
    expect(store.deleteTask).toHaveBeenCalledWith("FN-9271", { allowResurrection: false });
  });

  it("deletes when the audit sink throws", async () => {
    const store = createStore();
    vi.mocked(store.recordRunAuditEvent).mockImplementation(() => { throw new Error("audit unavailable"); });
    await softDeleteAsGhostBug(store, "FN-9271", decision);
    expect(store.deleteTask).toHaveBeenCalledWith("FN-9271", { allowResurrection: false });
  });

  it("deletes without waiting for a hanging mailbox delivery", async () => {
    const store = createStore();
    const messageStore = { sendMessageOnce: vi.fn().mockImplementation(() => new Promise<void>(() => undefined)) };
    await softDeleteAsGhostBug(store, "FN-9271", decision, { messageStore });
    expect(messageStore.sendMessageOnce).toHaveBeenCalled();
    expect(store.deleteTask).toHaveBeenCalledWith("FN-9271", { allowResurrection: false });
  });

  it("deletes without waiting for a hanging audit sink", async () => {
    const store = createStore();
    vi.mocked(store.recordRunAuditEvent).mockImplementation(() => new Promise<void>(() => undefined));
    await softDeleteAsGhostBug(store, "FN-9271", decision);
    expect(store.deleteTask).toHaveBeenCalledWith("FN-9271", { allowResurrection: false });
  });
});

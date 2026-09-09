import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";
import { SelfHealingManager } from "../self-healing.js";

function makeStore(recordRunAuditEvent?: (event: unknown) => unknown) {
  return {
    reconcileArchivedTasksIntoDone: vi.fn()
      .mockResolvedValueOnce({
        movedCount: 1,
        restoredCount: 1,
        hasMore: false,
        outcomes: [
          { taskId: "FN-LIVE", source: "live-column", outcome: "moved" },
          { taskId: "FN-COLD", source: "cold-storage", outcome: "restored" },
          { taskId: "FN-PAUSED", source: "live-column", outcome: "retained", reason: "user-paused" },
        ],
      })
      .mockResolvedValue({ movedCount: 0, restoredCount: 0, hasMore: false, outcomes: [] }),
    ...(recordRunAuditEvent ? { recordRunAuditEvent: vi.fn(recordRunAuditEvent) } : {}),
  };
}

describe("SelfHealingManager archived-to-Done reconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a bounded pass, audits both legacy sources, and is idempotent", async () => {
    const store = makeStore(() => Promise.resolve());
    const manager = new SelfHealingManager(store as never, { rootDir: "/repo" });

    await expect(manager.reconcileArchivedTasksIntoDone()).resolves.toBe(2);
    await expect(manager.reconcileArchivedTasksIntoDone()).resolves.toBe(0);

    expect(store.reconcileArchivedTasksIntoDone).toHaveBeenNthCalledWith(1, {
      limit: 200,
      maxFailureAttempts: 3,
    });
    expect(store.recordRunAuditEvent).toHaveBeenCalledTimes(3);
    expect(store.recordRunAuditEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      mutationType: "task:reconcile-archived-into-done",
      taskId: "FN-LIVE",
      metadata: {
        taskId: "FN-LIVE",
        source: "live-column",
        movedCount: 1,
        restoredCount: 0,
        outcome: "moved",
      },
    }));
    expect(store.recordRunAuditEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      mutationType: "task:reconcile-archived-into-done",
      taskId: "FN-COLD",
      metadata: {
        taskId: "FN-COLD",
        source: "cold-storage",
        movedCount: 0,
        restoredCount: 1,
        outcome: "restored",
      },
    }));
    expect(store.recordRunAuditEvent).toHaveBeenNthCalledWith(3, expect.objectContaining({
      taskId: "FN-PAUSED",
      metadata: expect.objectContaining({ outcome: "retained", reason: "user-paused" }),
    }));
  });

  it.each([
    ["absent", undefined],
    ["throwing", () => { throw new Error("sink failed"); }],
    ["rejecting", () => Promise.reject(new Error("sink rejected"))],
  ])("completes when the audit sink is %s", async (_name, sink) => {
    const store = makeStore(sink);
    const manager = new SelfHealingManager(store as never, { rootDir: "/repo" });

    await expect(manager.reconcileArchivedTasksIntoDone()).resolves.toBe(2);
  });

  it("completes when the audit sink never settles", async () => {
    vi.useFakeTimers();
    const store = makeStore(() => new Promise(() => undefined));
    const manager = new SelfHealingManager(store as never, { rootDir: "/repo" });

    const reconciliation = manager.reconcileArchivedTasksIntoDone();
    await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS * 4);

    await expect(reconciliation).resolves.toBe(2);
  });
});

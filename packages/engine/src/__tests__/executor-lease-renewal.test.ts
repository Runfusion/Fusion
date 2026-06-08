import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";

function createStore() {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  return {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    off: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([]),
    renewCheckoutLease: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("TaskExecutor lease renewal fallback", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("uses renewCheckoutLease instead of updateTask when agentStore is unavailable", async () => {
    const store = createStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).renewTaskLease("FN-5945", "agent-1", 3, "node-1", "run-1");

    expect(store.renewCheckoutLease).toHaveBeenCalledTimes(1);
    expect(store.renewCheckoutLease).toHaveBeenCalledWith(
      "FN-5945",
      expect.objectContaining({
        checkoutRunId: "run-1",
        checkoutLeaseRenewedAt: expect.any(String),
      }),
    );
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("keeps the agentStore checkoutTask renewal path unchanged", async () => {
    const store = createStore();
    const agentStore = { checkoutTask: vi.fn().mockResolvedValue(undefined) } as any;
    const executor = new TaskExecutor(store, "/tmp/test", { agentStore });

    await (executor as any).renewTaskLease("FN-5945", "agent-1", 4, "node-2", "run-2");

    expect(agentStore.checkoutTask).toHaveBeenCalledWith(
      "agent-1",
      "FN-5945",
      expect.objectContaining({
        nodeId: "node-2",
        runId: "run-2",
        leaseEpoch: 4,
        renewedAt: expect.any(String),
      }),
      undefined,
    );
    expect(store.renewCheckoutLease).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});

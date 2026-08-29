import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore, CheckoutConflictError, TaskStore } from "@fusion/core";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { hasPg, makePgAgentStore, makePgTaskStore } from "./reliability-interactions/_helpers.js";

const pgIt = hasPg ? pgDescribe : describe.skip;

pgIt("distributed claim mutex integration", () => {
  let taskStore: TaskStore;
  let agentStore: AgentStore;
  let cleanup: (() => Promise<void>) | undefined;
  let winnerAgentId = "";
  let loserAgentId = "";
  let taskId = "";

  beforeEach(async () => {
    const fixture = await makePgTaskStore();
    taskStore = fixture.store;
    cleanup = fixture.cleanup;
    agentStore = makePgAgentStore({ taskStore, layer: fixture.layer });
    await agentStore.init();

    winnerAgentId = (await agentStore.createAgent({ name: "winner", role: "executor" })).id;
    loserAgentId = (await agentStore.createAgent({ name: "loser", role: "executor" })).id;
    taskId = (await taskStore.createTask({ description: "distributed claim" })).id;
  });

  afterEach(async () => {
    agentStore?.close();
    await cleanup?.();
  });

  it("allows exactly one concurrent claimant and supports retry after release", async () => {
    const originalTryClaim = taskStore.tryClaimCheckout.bind(taskStore);
    let waiters = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    taskStore.tryClaimCheckout = async (...args) => {
      waiters += 1;
      if (waiters === 2) {
        releaseBarrier?.();
      }
      await barrier;
      return originalTryClaim(...args);
    };

    const [first, second] = await Promise.allSettled([
      agentStore.checkoutTask(winnerAgentId, taskId, { nodeId: "node-a", runId: "run-a" }),
      agentStore.checkoutTask(loserAgentId, taskId, { nodeId: "node-b", runId: "run-b" }),
    ]);

    const fulfilled = [first, second].filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<AgentStore["checkoutTask"]>>> => entry.status === "fulfilled");
    const rejected = [first, second].filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(CheckoutConflictError);

    const persisted = await taskStore.getTask(taskId);
    expect(persisted?.checkedOutBy).toBe(fulfilled[0].value.checkedOutBy);
    expect(persisted?.checkoutNodeId).toBe(fulfilled[0].value.checkoutNodeId);
    expect(persisted?.checkoutLeaseEpoch).toBe(1);
    expect([persisted?.checkedOutBy]).not.toContain(undefined);

    await taskStore.updateTask(taskId, { checkedOutBy: null, checkedOutAt: null, checkoutNodeId: null, checkoutRunId: null, checkoutLeaseRenewedAt: null });

    const retry = await agentStore.checkoutTask(loserAgentId, taskId, { nodeId: "node-b", runId: "run-c" });
    expect(retry.checkedOutBy).toBe(loserAgentId);
    expect(retry.checkoutLeaseEpoch).toBe(2);
  });
});

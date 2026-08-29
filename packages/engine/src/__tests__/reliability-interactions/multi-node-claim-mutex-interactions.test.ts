import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore, CheckoutConflictError, TaskStore } from "@fusion/core";
import { hasGit, hasPg, makePgAgentStore, makePgTaskStore } from "./_helpers.js";

const describeIfGit = hasGit && hasPg ? describe : describe.skip;

describeIfGit("reliability interactions: multi-node claim mutex", () => {
  let taskStore: TaskStore;
  let cleanup: (() => Promise<void>) | undefined;
  let agentStoreA: AgentStore;
  let agentStoreB: AgentStore;
  let taskId: string;
  let agentA: string;
  let agentB: string;

  beforeEach(async () => {
    const fixture = await makePgTaskStore();
    taskStore = fixture.store;
    cleanup = fixture.cleanup;

    agentStoreA = makePgAgentStore({ taskStore, layer: fixture.layer });
    agentStoreB = makePgAgentStore({ taskStore, layer: fixture.layer });
    await agentStoreA.init();
    await agentStoreB.init();

    agentA = (await agentStoreA.createAgent({ name: "exec-a", role: "executor" })).id;
    agentB = (await agentStoreA.createAgent({ name: "exec-b", role: "executor" })).id;
    taskId = (await taskStore.createTask({ description: "FN-4818 claim mutex interaction" })).id;
  });

  afterEach(async () => {
    agentStoreA?.close();
    agentStoreB?.close();
    await cleanup?.();
  });

  it("prevents split-brain, preserves renewal semantics, and keeps legacy conflict shape", async () => {
    // FN-4813: distributed claim mutex split-brain prevention
    const [first, second] = await Promise.allSettled([
      agentStoreA.checkoutTask(agentA, taskId, { nodeId: "node-a", runId: "run-a-1" }),
      agentStoreB.checkoutTask(agentB, taskId, { nodeId: "node-b", runId: "run-b-1" }),
    ]);

    const fulfilled = [first, second].filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<AgentStore["checkoutTask"]>>> => entry.status === "fulfilled");
    const rejected = [first, second].filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(CheckoutConflictError);

    const winnerTask = fulfilled[0].value;
    const winnerAgentId = winnerTask.checkedOutBy;
    const winnerNodeId = winnerTask.checkoutNodeId;
    const loserAgentId = winnerAgentId === agentA ? agentB : agentA;
    const loserNodeId = winnerNodeId === "node-a" ? "node-b" : "node-a";

    const postRace = await taskStore.getTask(taskId);
    expect(postRace?.checkedOutBy).toBe(winnerAgentId);
    expect(postRace?.checkoutNodeId).toBe(winnerNodeId);
    expect(postRace?.checkoutLeaseEpoch).toBe(winnerTask.checkoutLeaseEpoch);
    expect(postRace?.checkoutLeaseEpoch).toBeGreaterThan(0);
    expect(postRace?.checkedOutBy).not.toBe(loserAgentId);
    expect(postRace?.checkoutNodeId).not.toBe(loserNodeId);

    // FN-4813: owner renewal with matching epoch must not bump checkoutLeaseEpoch
    const renewalEpoch = postRace?.checkoutLeaseEpoch ?? 0;
    const renewalBefore = postRace?.checkoutLeaseRenewedAt ?? postRace?.checkedOutAt;
    const renewedAt = new Date(Date.now() + 1_000).toISOString();
    const renewed = await (winnerAgentId === agentA ? agentStoreA : agentStoreB).checkoutTask(winnerAgentId ?? "", taskId, {
      nodeId: winnerNodeId ?? "",
      runId: "run-renew",
      leaseEpoch: renewalEpoch,
      renewedAt,
    });

    expect(renewed.checkoutLeaseEpoch).toBe(renewalEpoch);
    expect(renewed.checkoutLeaseRenewedAt).toBe(renewedAt);
    if (renewalBefore) {
      expect(Date.parse(renewed.checkoutLeaseRenewedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(renewalBefore));
    }

    // FN-4813: stale-epoch peer claim is rejected and row stays unchanged
    await expect(
      agentStoreB.checkoutTask(agentB, taskId, { nodeId: "node-b", leaseEpoch: 0, runId: "run-b-2" }),
    ).rejects.toBeInstanceOf(CheckoutConflictError);

    const afterStalePeer = await taskStore.getTask(taskId);
    expect(afterStalePeer?.checkedOutBy).toBe(winnerAgentId);
    expect(afterStalePeer?.checkoutNodeId).toBe(winnerNodeId);
    expect(afterStalePeer?.checkoutLeaseEpoch).toBe(renewalEpoch);

    // FN-4813: recovery handoff after release allows peer reclaim and bumps epoch by one
    await taskStore.updateTask(taskId, {
      checkedOutBy: null,
      checkedOutAt: null,
      checkoutNodeId: null,
      checkoutRunId: null,
      checkoutLeaseRenewedAt: null,
    });

    const reclaimed = await agentStoreB.checkoutTask(agentB, taskId, { nodeId: "node-b", runId: "run-b-3" });
    expect(reclaimed.checkedOutBy).toBe(agentB);
    expect(reclaimed.checkoutNodeId).toBe("node-b");
    expect(reclaimed.checkoutLeaseEpoch).toBe(renewalEpoch + 1);

    // FN-4813: legacy single-process checkout conflict shape remains intact
    await expect(agentStoreA.checkoutTask(agentA, taskId)).rejects.toMatchObject({
      taskId,
      currentHolderId: agentB,
      requestedById: agentA,
    });
  });
});

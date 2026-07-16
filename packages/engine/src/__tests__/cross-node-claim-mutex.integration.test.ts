import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore, AsyncCentralClaimStore, CheckoutConflictError, TaskStore } from "@fusion/core";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createPgLayer, hasPg, makePgAgentStore, makePgTaskStore } from "./reliability-interactions/_helpers.js";

const pgIt = hasPg ? pgDescribe : describe.skip;

pgIt("cross-node claim mutex integration", () => {
  let taskStore: TaskStore;
  let centralClaimStore: AsyncCentralClaimStore;
  let storeA: AgentStore;
  let storeB: AgentStore;
  let cleanupTaskStore: (() => Promise<void>) | undefined;
  let cleanupCentralLayer: (() => Promise<void>) | undefined;
  let agentA: string;
  let agentB: string;
  let taskId: string;

  beforeEach(async () => {
    const taskFixture = await makePgTaskStore();
    const centralFixture = await createPgLayer();
    taskStore = taskFixture.store;
    cleanupTaskStore = taskFixture.cleanup;
    cleanupCentralLayer = centralFixture.cleanup;
    centralClaimStore = new AsyncCentralClaimStore(centralFixture.layer);

    storeA = makePgAgentStore({
      taskStore,
      layer: taskFixture.layer,
      claimStore: centralClaimStore,
      projectId: "P-1",
      nodeId: "node-a",
    });
    storeB = makePgAgentStore({
      taskStore,
      layer: taskFixture.layer,
      claimStore: centralClaimStore,
      projectId: "P-1",
      nodeId: "node-b",
    });
    await storeA.init();
    await storeB.init();

    agentA = (await storeA.createAgent({ name: "agent-a", role: "executor" })).id;
    agentB = (await storeB.createAgent({ name: "agent-b", role: "executor" })).id;
    taskId = (await taskStore.createTask({ description: "cross-node claim race" })).id;
  });

  afterEach(async () => {
    storeA?.close();
    storeB?.close();
    await cleanupTaskStore?.();
    await cleanupCentralLayer?.();
  });

  it("allows one winner per race and bumps epoch once per successful ownership acquisition", async () => {
    const originalTryClaim = centralClaimStore.tryClaimTask.bind(centralClaimStore);
    const installBarrier = () => {
      let waiters = 0;
      let releaseBarrier: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });

      centralClaimStore.tryClaimTask = async (input: Parameters<AsyncCentralClaimStore["tryClaimTask"]>[0]) => {
        waiters += 1;
        if (waiters === 2) {
          releaseBarrier?.();
        }
        await barrier;
        return originalTryClaim(input);
      };
    };

    installBarrier();
    const [first, second] = await Promise.allSettled([
      storeA.checkoutTask(agentA, taskId, { nodeId: "node-a", runId: "run-a" }),
      storeB.checkoutTask(agentB, taskId, { nodeId: "node-b", runId: "run-b" }),
    ]);

    const fulfilled = [first, second].filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<AgentStore["checkoutTask"]>>> => entry.status === "fulfilled");
    const rejected = [first, second].filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(CheckoutConflictError);

    const winner = fulfilled[0].value;
    expect(rejected[0].reason.currentHolderId).toBe(winner.checkedOutBy);
    expect((await centralClaimStore.getTaskClaim("P-1", taskId))?.leaseEpoch).toBe(1);
    expect(winner.checkoutLeaseEpoch).toBe(1);
    expect(["node-a", "node-b"]).toContain(winner.checkoutNodeId);

    await (winner.checkedOutBy === agentA ? storeA : storeB).releaseTask(winner.checkedOutBy ?? "", taskId);

    installBarrier();
    const [third, fourth] = await Promise.allSettled([
      storeA.checkoutTask(agentA, taskId, { nodeId: "node-a", runId: "run-c" }),
      storeB.checkoutTask(agentB, taskId, { nodeId: "node-b", runId: "run-d" }),
    ]);

    const fulfilled2 = [third, fourth].filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<AgentStore["checkoutTask"]>>> => entry.status === "fulfilled");
    const rejected2 = [third, fourth].filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");

    expect(fulfilled2).toHaveLength(1);
    expect(rejected2).toHaveLength(1);
    expect(rejected2[0].reason).toBeInstanceOf(CheckoutConflictError);
    expect((await centralClaimStore.getTaskClaim("P-1", taskId))?.leaseEpoch).toBe(1);
  });
});

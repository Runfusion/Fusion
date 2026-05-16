import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore } from "../agent-store.js";
import { TaskStore } from "../store.js";
import { CheckoutConflictError } from "../types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-checkout-claim-test-"));
}

describe("checkout claim mutex", () => {
  let rootDir: string;
  let taskStore: TaskStore;
  let agentStore: AgentStore;
  let globalDir: string;
  let taskId: string;
  let agentA: string;
  let agentB: string;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = join(rootDir, ".fusion-global");
    taskStore = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await taskStore.init();
    agentStore = new AgentStore({ rootDir, inMemoryDb: true, taskStore });
    await agentStore.init();

    agentA = (await agentStore.createAgent({ name: "A", role: "executor" })).id;
    agentB = (await agentStore.createAgent({ name: "B", role: "executor" })).id;
    taskId = (await taskStore.createTask({ description: "claim me" })).id;
  });

  afterEach(async () => {
    agentStore?.close();
    taskStore?.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("first claimant wins and epoch becomes 1", async () => {
    const claimed = await agentStore.checkoutTask(agentA, taskId, { nodeId: "node-a", runId: "run-1" });
    expect(claimed.checkedOutBy).toBe(agentA);
    expect(claimed.checkoutNodeId).toBe("node-a");
    expect(claimed.checkoutLeaseEpoch).toBe(1);
  });

  it("different agent claim conflicts and preserves owner", async () => {
    await agentStore.checkoutTask(agentA, taskId, { nodeId: "node-a", runId: "run-1" });
    await expect(agentStore.checkoutTask(agentB, taskId, { nodeId: "node-b", runId: "run-2" })).rejects.toBeInstanceOf(CheckoutConflictError);
    const current = await taskStore.getTask(taskId);
    expect(current?.checkedOutBy).toBe(agentA);
    expect(current?.checkoutNodeId).toBe("node-a");
  });

  it("same agent on different node conflicts", async () => {
    await agentStore.checkoutTask(agentA, taskId, { nodeId: "node-a", runId: "run-1" });
    await expect(agentStore.checkoutTask(agentA, taskId, { nodeId: "node-b", runId: "run-2", leaseEpoch: 1 })).rejects.toBeInstanceOf(CheckoutConflictError);
  });

  it("renewal with matching epoch succeeds and does not bump epoch", async () => {
    await agentStore.checkoutTask(agentA, taskId, { nodeId: "node-a", runId: "run-1" });
    const renewed = await agentStore.checkoutTask(agentA, taskId, { nodeId: "node-a", runId: "run-2", leaseEpoch: 1, renewedAt: "2026-05-16T00:00:00.000Z" });
    expect(renewed.checkoutLeaseEpoch).toBe(1);
    expect(renewed.checkoutRunId).toBe("run-2");
    expect(renewed.checkoutLeaseRenewedAt).toBe("2026-05-16T00:00:00.000Z");
  });

  it("renewal with stale epoch conflicts", async () => {
    await agentStore.checkoutTask(agentA, taskId, { nodeId: "node-a", runId: "run-1" });
    await expect(agentStore.checkoutTask(agentA, taskId, { nodeId: "node-a", runId: "run-2", leaseEpoch: 0 })).rejects.toBeInstanceOf(CheckoutConflictError);
  });
});

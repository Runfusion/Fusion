import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore } from "../agent-store.js";
import { createCentralDatabase, type CentralDatabase } from "../central-db.js";
import { TaskStore } from "../store.js";
import { CheckoutConflictError } from "../types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-agent-central-claim-test-"));
}

describe("AgentStore central claim wiring", () => {
  let rootDir: string;
  let globalDir: string;
  let taskStore: TaskStore;
  let centralDb: CentralDatabase;
  let agentStoreA: AgentStore;
  let agentStoreB: AgentStore;
  let taskId: string;
  let agentA: string;
  let agentB: string;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = join(rootDir, ".fusion-global");
    taskStore = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await taskStore.init();
    centralDb = createCentralDatabase(globalDir);
    centralDb.init();

    agentStoreA = new AgentStore({ rootDir, inMemoryDb: true, taskStore, claimStore: centralDb, projectId: "P-1", nodeId: "node-a" });
    agentStoreB = new AgentStore({ rootDir, inMemoryDb: true, taskStore, claimStore: centralDb, projectId: "P-1", nodeId: "node-b" });
    await agentStoreA.init();
    await agentStoreB.init();

    agentA = (await agentStoreA.createAgent({ name: "A", role: "executor" })).id;
    agentB = (await agentStoreB.createAgent({ name: "B", role: "executor" })).id;
    taskId = (await taskStore.createTask({ description: "claim me" })).id;
  });

  afterEach(async () => {
    agentStoreA?.close();
    agentStoreB?.close();
    taskStore?.close();
    centralDb?.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("successful claim writes central row and per-project mirror", async () => {
    const claimed = await agentStoreA.checkoutTask(agentA, taskId, { runId: "run-1" });
    const central = centralDb.getTaskClaim("P-1", taskId);
    expect(central).toBeTruthy();
    expect(central?.ownerAgentId).toBe(agentA);
    expect(central?.ownerNodeId).toBe("node-a");
    expect(central?.leaseEpoch).toBe(claimed.checkoutLeaseEpoch);
    expect(claimed.checkoutNodeId).toBe(central?.ownerNodeId);
  });

  it("conflict uses central holder even when project row is stale", async () => {
    await agentStoreA.checkoutTask(agentA, taskId, { runId: "run-1" });
    await taskStore.updateTask(taskId, {
      checkedOutBy: null,
      checkedOutAt: null,
      checkoutNodeId: null,
      checkoutRunId: null,
      checkoutLeaseRenewedAt: null,
      checkoutLeaseEpoch: null,
    });

    await expect(agentStoreB.checkoutTask(agentB, taskId, { runId: "run-2" })).rejects.toMatchObject({
      name: "CheckoutConflictError",
      currentHolderId: agentA,
    } satisfies Partial<CheckoutConflictError>);
  });

  it("renewal by same owner does not bump epoch", async () => {
    await agentStoreA.checkoutTask(agentA, taskId, { runId: "run-1" });
    const before = centralDb.getTaskClaim("P-1", taskId);
    const renewed = await agentStoreA.checkoutTask(agentA, taskId, { runId: "run-2", leaseEpoch: before?.leaseEpoch, renewedAt: "2026-05-16T00:00:00.000Z" });
    const after = centralDb.getTaskClaim("P-1", taskId);
    expect(before?.leaseEpoch).toBe(1);
    expect(after?.leaseEpoch).toBe(before?.leaseEpoch);
    expect(renewed.checkoutLeaseEpoch).toBe(before?.leaseEpoch);
  });

  it("owner release clears central row and next owner reclaims at epoch 1", async () => {
    await agentStoreA.checkoutTask(agentA, taskId, { runId: "run-1" });
    await agentStoreA.releaseTask(agentA, taskId);
    expect(centralDb.getTaskClaim("P-1", taskId)).toBeNull();

    const claimedByB = await agentStoreB.checkoutTask(agentB, taskId, { runId: "run-2" });
    expect(claimedByB.checkedOutBy).toBe(agentB);
    expect(claimedByB.checkoutLeaseEpoch).toBe(1);
    expect(centralDb.getTaskClaim("P-1", taskId)?.leaseEpoch).toBe(1);
  });

  it("constructor throws when claimStore is provided without projectId", () => {
    expect(() => new AgentStore({ rootDir, inMemoryDb: true, taskStore, claimStore: centralDb })).toThrow(
      "AgentStore requires projectId when claimStore is configured",
    );
  });
});

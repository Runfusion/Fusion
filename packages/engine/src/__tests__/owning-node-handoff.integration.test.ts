import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore, type OwningNodeHandoffPolicy } from "@fusion/core";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { hasPg, makePgTaskStore } from "./reliability-interactions/_helpers.js";
import { MeshLeaseManager } from "../project/mesh-lease-manager.js";
import type { NodeHealthMonitor } from "../project/node-health-monitor.js";

const pgIt = hasPg ? pgDescribe : describe.skip;

pgIt("MeshLeaseManager owning-node handoff integration", () => {
  let taskStore: TaskStore;
  let cleanup: (() => Promise<void>) | undefined;
  let taskId: string;

  beforeEach(async () => {
    const fixture = await makePgTaskStore();
    taskStore = fixture.store;
    cleanup = fixture.cleanup;
    taskId = (await taskStore.createTask({ description: "handoff" })).id;
  });

  afterEach(async () => {
    await cleanup?.();
  });

  async function seedLease(ownerNodeId: string): Promise<void> {
    await taskStore.updateTask(taskId, {
      checkedOutBy: "agent-1",
      checkedOutAt: "2026-05-01T00:00:00.000Z",
      checkoutLeaseRenewedAt: "2026-05-01T00:00:00.000Z",
      checkoutLeaseEpoch: 1,
      checkoutNodeId: ownerNodeId,
    });
  }

  async function runCase(policy: OwningNodeHandoffPolicy, ownerNodeId: string): Promise<boolean> {
    const manager = new MeshLeaseManager({
      taskStore,
      localNodeId: "node-local",
      getHandoffPolicy: async () => policy,
      nodeHealthMonitor: {
        getNodeHealth: () => (ownerNodeId === "node-local" ? "online" : "offline"),
      } as unknown as NodeHealthMonitor,
    });
    return manager.recoverAbandonedLease(taskId, "test-owner-unavailable", { preserveProgress: true });
  }

  it("applies handoff policy matrix for peer-owned leases", async () => {
    await seedLease("node-peer");
    let baselineEventIds = new Set((await taskStore.getRunAuditEventsAsync({ taskId, limit: 200 })).map((event) => event.id));
    expect(await runCase("block", "node-peer")).toBe(false);
    let task = await taskStore.getTask(taskId);
    expect(task?.checkedOutBy).toBe("agent-1");
    let newEvents = (await taskStore.getRunAuditEventsAsync({ taskId, limit: 200 })).filter((event) => !baselineEventIds.has(event.id));
    expect(newEvents.some((event) => event.mutationType === "node:handoff:parked" && event.metadata?.source === "mesh-lease.recover" && event.metadata?.decisionReason === "handoff_blocked_by_policy")).toBe(true);
    expect(newEvents.some((event) => event.mutationType === "node:lease:recovered")).toBe(false);

    await seedLease("node-peer");
    baselineEventIds = new Set((await taskStore.getRunAuditEventsAsync({ taskId, limit: 200 })).map((event) => event.id));
    expect(await runCase("reassign-to-local", "node-peer")).toBe(true);
    task = await taskStore.getTask(taskId);
    expect(task?.checkedOutBy ?? null).toBeNull();
    newEvents = (await taskStore.getRunAuditEventsAsync({ taskId, limit: 200 })).filter((event) => !baselineEventIds.has(event.id));
    const localRecoveryEvent = newEvents.find((event) => event.mutationType === "node:lease:recovered");
    expect(localRecoveryEvent).toBeTruthy();
    expect(localRecoveryEvent?.metadata?.source).toBe("mesh-lease.recover");
    expect(typeof localRecoveryEvent?.metadata?.epoch).toBe("number");
    expect(String(localRecoveryEvent?.metadata?.recoveryReason ?? "")).toContain("test-owner-unavailable");

    await seedLease("node-peer");
    baselineEventIds = new Set((await taskStore.getRunAuditEventsAsync({ taskId, limit: 200 })).map((event) => event.id));
    expect(await runCase("reassign-any-healthy", "node-peer")).toBe(true);
    task = await taskStore.getTask(taskId);
    expect(task?.checkedOutBy ?? null).toBeNull();
    newEvents = (await taskStore.getRunAuditEventsAsync({ taskId, limit: 200 })).filter((event) => !baselineEventIds.has(event.id));
    const anyRecoveryEvent = newEvents.find((event) => event.mutationType === "node:lease:recovered");
    expect(anyRecoveryEvent).toBeTruthy();
    expect(anyRecoveryEvent?.metadata?.source).toBe("mesh-lease.recover");
    expect(typeof anyRecoveryEvent?.metadata?.epoch).toBe("number");
    expect(String(anyRecoveryEvent?.metadata?.recoveryReason ?? "")).toContain("test-owner-unavailable");
  });

  it("recovers self-owned leases regardless of policy", async () => {
    for (const policy of ["block", "reassign-to-local", "reassign-any-healthy"] as const) {
      await seedLease("node-local");
      const baselineEventIds = new Set((await taskStore.getRunAuditEventsAsync({ taskId, limit: 200 })).map((event) => event.id));
      const recovered = await runCase(policy, "node-local");
      expect(recovered).toBe(true);
      const task = await taskStore.getTask(taskId);
      expect(task?.checkedOutBy ?? null).toBeNull();
      const newEvents = (await taskStore.getRunAuditEventsAsync({ taskId, limit: 200 })).filter((event) => !baselineEventIds.has(event.id));
      const recoveryEvents = newEvents.filter((event) => event.mutationType === "node:lease:recovered");
      expect(recoveryEvents).toHaveLength(1);
      expect(recoveryEvents[0]?.metadata?.source).toBe("mesh-lease.recover");
    }
  });
});

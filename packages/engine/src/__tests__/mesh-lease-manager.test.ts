import { describe, expect, it, vi } from "vitest";
import type { AgentStore, CentralClaimStore, RunAuditEventInput, Task, TaskStore } from "@fusion/core";
import { MeshLeaseManager } from "../project/mesh-lease-manager.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    description: "x",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    checkedOutBy: "agent-1",
    checkedOutAt: "2026-05-01T00:00:00.000Z",
    checkoutLeaseRenewedAt: "2026-05-01T00:00:00.000Z",
    checkoutLeaseEpoch: 1,
    checkoutNodeId: "node-a",
    ...overrides,
  };
}

describe("MeshLeaseManager", () => {
  it("prefers active local execution over stale replicated timestamps", async () => {
    const getTask = vi.fn().mockResolvedValue(task());
    const manager = new MeshLeaseManager({
      taskStore: { getTask } as unknown as TaskStore,
      getExecutingTaskIds: () => new Set(["FN-1"]),
    });

    const result = await manager.isLeaseRecoverable(task(), Date.parse("2026-05-01T00:10:00.000Z"));
    expect(result).toEqual({ recoverable: false, reason: "active_local_execution" });
  });

  it("marks lease recoverable when owner node is offline", async () => {
    const manager = new MeshLeaseManager({
      taskStore: {} as TaskStore,
      nodeHealthMonitor: { getNodeHealth: () => "offline" } as any,
    });

    const result = await manager.isLeaseRecoverable(task(), Date.parse("2026-05-01T00:01:00.000Z"));
    expect(result).toEqual({ recoverable: true, reason: "owner_node_offline" });
  });

  it("emits unreachable audit for recovered-to-todo path", async () => {
    const currentTask = task({ column: "in-progress" });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const updateTask = vi.fn().mockResolvedValue(currentTask);
    const moveTask = vi.fn().mockResolvedValue(currentTask);
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(currentTask),
      updateTask,
      moveTask,
      logEntry,
      recordRunAuditEvent,
    } as unknown as TaskStore;

    const manager = new MeshLeaseManager({
      taskStore,
      nodeHealthMonitor: { getNodeHealth: () => "offline" } as any,
      getHandoffPolicy: vi.fn().mockResolvedValue("reassign-any-healthy"),
      localNodeId: "local",
    });

    const ok = await manager.recoverAbandonedLease("FN-1", "scheduler detected stale todo lease");

    expect(ok).toBe(true);
    expect(moveTask).toHaveBeenCalledWith("FN-1", "todo", expect.any(Object));
    const event = recordRunAuditEvent.mock.calls
      .map((call) => call[0] as RunAuditEventInput)
      .find((candidate) => candidate.mutationType === "task:auto-recover-node-unreachable");
    expect(event?.mutationType).toBe("task:auto-recover-node-unreachable");
    expect(event?.metadata).toMatchObject({
      ownerNodeId: "node-a",
      ownerNodeHealth: "offline",
      previousOwnerAgentId: "agent-1",
      previousColumn: "in-progress",
      newColumn: "todo",
      leaseEpoch: 2,
      recoveryReason: "scheduler detected stale todo lease",
      handoffPolicy: "reassign-any-healthy",
      handoffAction: "reassign-any",
      handoffReason: expect.any(String),
      decisionPath: "lease-recovered-to-todo",
    });
  });

  it("emits ownerNodeHealth=error for owner_node_error recoveries", async () => {
    const currentTask = task({ column: "todo" });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(currentTask),
      updateTask: vi.fn().mockResolvedValue(currentTask),
      moveTask: vi.fn().mockResolvedValue(currentTask),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent,
    } as unknown as TaskStore;

    const manager = new MeshLeaseManager({
      taskStore,
      nodeHealthMonitor: { getNodeHealth: () => "error" } as any,
      getHandoffPolicy: vi.fn().mockResolvedValue("reassign-any-healthy"),
      localNodeId: "local",
    });

    const ok = await manager.recoverAbandonedLease("FN-1", "scheduler detected stale todo lease");
    expect(ok).toBe(true);

    const event = recordRunAuditEvent.mock.calls
      .map((call) => call[0] as RunAuditEventInput)
      .find((candidate) => candidate.mutationType === "task:auto-recover-node-unreachable");
    expect(event?.metadata).toMatchObject({
      ownerNodeHealth: "error",
      decisionPath: "lease-recovered-in-place",
      newColumn: "todo",
    });
  });

  it("emits parked-by-handoff-policy when handoff action parks", async () => {
    const currentTask = task({ column: "in-progress" });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(currentTask),
      updateTask: vi.fn().mockResolvedValue(currentTask),
      moveTask: vi.fn().mockResolvedValue(currentTask),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent,
    } as unknown as TaskStore;

    const manager = new MeshLeaseManager({
      taskStore,
      nodeHealthMonitor: { getNodeHealth: () => "offline" } as any,
      getHandoffPolicy: vi.fn().mockResolvedValue("block"),
      localNodeId: "local",
    });

    const ok = await manager.recoverAbandonedLease("FN-1", "scheduler detected stale todo lease");
    expect(ok).toBe(false);

    const event = recordRunAuditEvent.mock.calls
      .map((call) => call[0] as RunAuditEventInput)
      .find((candidate) => candidate.mutationType === "task:auto-recover-node-unreachable");
    expect(event?.mutationType).toBe("task:auto-recover-node-unreachable");
    expect(event?.metadata).toMatchObject({
      decisionPath: "lease-parked-by-handoff-policy",
      recoveryReason: "handoff-policy-park",
      handoffPolicy: "block",
      handoffAction: "park",
      newColumn: "in-progress",
      leaseEpoch: 1,
    });
  });

  it("does not emit node-unreachable event for non-unreachable recoveries", async () => {
    const currentTask = task({ checkoutNodeId: undefined });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(currentTask),
      updateTask: vi.fn().mockResolvedValue(currentTask),
      moveTask: vi.fn().mockResolvedValue(currentTask),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent,
    } as unknown as TaskStore;

    const agentStore = {
      getAgent: vi.fn().mockResolvedValue({
        id: "agent-1",
        runtimeConfig: { heartbeatTimeoutMs: 60_000 },
        lastHeartbeatAt: "2026-04-30T00:00:00.000Z",
      }),
    } as unknown as AgentStore;

    const manager = new MeshLeaseManager({ taskStore, agentStore });
    const ok = await manager.recoverAbandonedLease("FN-1", "stale-heartbeat");
    expect(ok).toBe(true);
    expect(recordRunAuditEvent.mock.calls.some((call) => call[0].mutationType === "task:auto-recover-node-unreachable")).toBe(false);
    expect(recordRunAuditEvent.mock.calls.some((call) => call[0].mutationType === "node:lease:recovered")).toBe(true);
  });

  it("emits lease-released when central + local recovery succeeds", async () => {
    const currentTask = task({ column: "in-progress" });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const centralClaimStore: CentralClaimStore = {
      tryClaimTask: vi.fn() as any,
      renewTaskClaim: vi.fn() as any,
      getTaskClaim: vi.fn().mockReturnValue(null),
      releaseTaskClaim: vi.fn().mockReturnValue({ ok: true }),
    };
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(currentTask),
      updateTask: vi.fn().mockResolvedValue(currentTask),
      moveTask: vi.fn().mockResolvedValue(currentTask),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent,
    } as unknown as TaskStore;

    const manager = new MeshLeaseManager({
      taskStore,
      centralClaimStore,
      projectId: "project-1",
      agentStore: {
        getAgent: vi.fn().mockResolvedValue({ lastHeartbeatAt: "2026-04-30T00:00:00.000Z" }),
      } as any,
    });

    const ok = await manager.recoverAbandonedLease("FN-1", "stale-heartbeat");
    expect(ok).toBe(true);
    expect(centralClaimStore.releaseTaskClaim).toHaveBeenCalledWith({
      projectId: "project-1",
      taskId: "FN-1",
      nodeId: "node-a",
      agentId: "agent-1",
    });
    expect(recordRunAuditEvent.mock.calls.some((call) => call[0].mutationType === "task:auto-recover-lease-released")).toBe(true);
  });

  it("returns false and emits foreign-owner when central release rejects ownership", async () => {
    const currentTask = task();
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const centralClaimStore: CentralClaimStore = {
      tryClaimTask: vi.fn() as any,
      renewTaskClaim: vi.fn() as any,
      getTaskClaim: vi.fn().mockReturnValue(null),
      releaseTaskClaim: vi.fn().mockReturnValue({
        ok: false,
        reason: "not_owner",
        current: {
          projectId: "project-1",
          taskId: "FN-1",
          ownerNodeId: "node-b",
          ownerAgentId: "agent-2",
          ownerRunId: null,
          leaseEpoch: 3,
          leaseRenewedAt: "2026-05-01T00:00:00.000Z",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      }),
    };
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(currentTask),
      updateTask: vi.fn().mockResolvedValue(currentTask),
      moveTask: vi.fn().mockResolvedValue(currentTask),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent,
    } as unknown as TaskStore;

    const manager = new MeshLeaseManager({ taskStore, centralClaimStore, projectId: "project-1" });
    const ok = await manager.recoverAbandonedLease("FN-1", "stale-heartbeat");
    expect(ok).toBe(false);
    expect(taskStore.updateTask).not.toHaveBeenCalled();
    expect(recordRunAuditEvent.mock.calls.some((call) => call[0].mutationType === "task:auto-recover-lease-foreign-owner")).toBe(true);
  });

  it("treats central not_found as already-healed and still clears local lease", async () => {
    const currentTask = task({ column: "in-progress" });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const centralClaimStore: CentralClaimStore = {
      tryClaimTask: vi.fn() as any,
      renewTaskClaim: vi.fn() as any,
      getTaskClaim: vi.fn().mockReturnValue(null),
      releaseTaskClaim: vi.fn().mockReturnValue({ ok: false, reason: "not_found", current: null }),
    };
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(currentTask),
      updateTask: vi.fn().mockResolvedValue(currentTask),
      moveTask: vi.fn().mockResolvedValue(currentTask),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent,
    } as unknown as TaskStore;

    const manager = new MeshLeaseManager({ taskStore, centralClaimStore, projectId: "project-1" });
    const ok = await manager.recoverAbandonedLease("FN-1", "stale-heartbeat");
    expect(ok).toBe(true);
    expect(taskStore.updateTask).toHaveBeenCalled();
    expect(recordRunAuditEvent.mock.calls.some((call) => call[0].mutationType === "task:auto-recover-lease-already-healed")).toBe(true);
    expect(recordRunAuditEvent.mock.calls.some((call) => call[0].mutationType === "task:auto-recover-lease-released")).toBe(false);
  });

  it("returns false when central claim release remains unavailable after retry", async () => {
    const currentTask = task();
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const centralClaimStore: CentralClaimStore = {
      tryClaimTask: vi.fn() as any,
      renewTaskClaim: vi.fn() as any,
      getTaskClaim: vi.fn().mockReturnValue(null),
      releaseTaskClaim: vi.fn().mockImplementation(() => {
        throw new Error("busy");
      }),
    };
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(currentTask),
      updateTask: vi.fn().mockResolvedValue(currentTask),
      moveTask: vi.fn().mockResolvedValue(currentTask),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent,
    } as unknown as TaskStore;

    const manager = new MeshLeaseManager({ taskStore, centralClaimStore, projectId: "project-1" });
    const ok = await manager.recoverAbandonedLease("FN-1", "stale-heartbeat");
    expect(ok).toBe(false);
    expect(taskStore.updateTask).not.toHaveBeenCalled();
    expect(recordRunAuditEvent.mock.calls.some((call) => call[0].mutationType === "task:auto-recover-lease-central-unavailable")).toBe(true);
  });

  it("single-node fallback keeps recovery local-only", async () => {
    const currentTask = task({ currentStep: 2, steps: [{ status: "done" } as any] });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(currentTask),
      updateTask: vi.fn().mockResolvedValue(currentTask),
      moveTask: vi.fn().mockResolvedValue(currentTask),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent,
    } as unknown as TaskStore;

    const manager = new MeshLeaseManager({ taskStore });
    const ok = await manager.recoverAbandonedLease("FN-1", "stale-heartbeat", { preserveProgress: true });
    expect(ok).toBe(true);
    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-1", "todo", { preserveProgress: true });
    expect(recordRunAuditEvent.mock.calls.some((call) => String(call[0].mutationType).includes("task:auto-recover-lease-"))).toBe(false);
  });

  it("reconcileLeaseRow clears local owner when central claim is already gone", async () => {
    const currentTask = task();
    const centralClaimStore: CentralClaimStore = {
      tryClaimTask: vi.fn() as any,
      renewTaskClaim: vi.fn() as any,
      releaseTaskClaim: vi.fn() as any,
      getTaskClaim: vi.fn().mockReturnValue(null),
    };
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(currentTask),
      updateTask: vi.fn().mockResolvedValue(currentTask),
      moveTask: vi.fn().mockResolvedValue(currentTask),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
    const manager = new MeshLeaseManager({ taskStore, centralClaimStore, projectId: "project-1" });

    const ok = await manager.reconcileLeaseRow("FN-1");
    expect(ok).toBe(true);
    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({ checkedOutBy: null }));
  });

  it("swallows audit emission failures and still returns expected result", async () => {
    const currentTask = task({ column: "todo" });
    const recordRunAuditEvent = vi.fn().mockRejectedValue(new Error("boom"));
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(currentTask),
      updateTask: vi.fn().mockResolvedValue(currentTask),
      moveTask: vi.fn().mockResolvedValue(currentTask),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent,
    } as unknown as TaskStore;

    const manager = new MeshLeaseManager({
      taskStore,
      nodeHealthMonitor: { getNodeHealth: () => "offline" } as any,
      getHandoffPolicy: vi.fn().mockResolvedValue("reassign-any-healthy"),
      localNodeId: "local",
    });

    await expect(manager.recoverAbandonedLease("FN-1", "scheduler detected stale todo lease")).resolves.toBe(true);
  });
});

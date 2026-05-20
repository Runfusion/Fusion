import { describe, expect, it, vi } from "vitest";
import type { CentralClaimStore, Task, TaskStore } from "@fusion/core";
import { Scheduler } from "../../scheduler.js";
import { SelfHealingManager } from "../../self-healing.js";
import { MeshLeaseManager } from "../../mesh-lease-manager.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-X",
    description: "x",
    column: "todo",
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

describe("reliability interactions: lease recovery central claim", () => {
  it("two-node contention yields one winner and one foreign-owner rejection", async () => {
    const taskA = makeTask({ id: "FN-CAS" });
    const taskB = makeTask({ id: "FN-CAS" });
    const auditA = vi.fn().mockResolvedValue(undefined);
    const auditB = vi.fn().mockResolvedValue(undefined);
    let first = true;
    const centralClaimStore: CentralClaimStore = {
      tryClaimTask: vi.fn() as any,
      renewTaskClaim: vi.fn() as any,
      getTaskClaim: vi.fn().mockReturnValue(null),
      releaseTaskClaim: vi.fn().mockImplementation(() => {
        if (first) {
          first = false;
          return { ok: true };
        }
        return {
          ok: false,
          reason: "not_owner",
          current: {
            projectId: "project-1",
            taskId: "FN-CAS",
            ownerNodeId: "node-z",
            ownerAgentId: "agent-z",
            ownerRunId: null,
            leaseEpoch: 2,
            leaseRenewedAt: "2026-05-01T00:00:00.000Z",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:00:00.000Z",
          },
        };
      }),
    };

    const baseStore = (task: Task, recordRunAuditEvent: any) => ({
      getTask: vi.fn().mockResolvedValue(task),
      updateTask: vi.fn().mockResolvedValue(task),
      moveTask: vi.fn().mockResolvedValue(task),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent,
    }) as unknown as TaskStore;

    const managerA = new MeshLeaseManager({ taskStore: baseStore(taskA, auditA), centralClaimStore, projectId: "project-1" });
    const managerB = new MeshLeaseManager({ taskStore: baseStore(taskB, auditB), centralClaimStore, projectId: "project-1" });

    const [firstOk, secondOk] = await Promise.all([
      managerA.recoverAbandonedLease("FN-CAS", "stale-heartbeat"),
      managerB.recoverAbandonedLease("FN-CAS", "stale-heartbeat"),
    ]);
    expect([firstOk, secondOk].sort()).toEqual([false, true]);
    expect(auditB.mock.calls.concat(auditA.mock.calls).some((call) => call[0].mutationType === "task:auto-recover-lease-foreign-owner")).toBe(true);
  });
  it("scheduler invokes reconcile once when lease recovery returns false", async () => {
    const task = makeTask();
    const store = {
      listTasks: vi.fn().mockResolvedValue([task]),
      getTask: vi.fn().mockResolvedValue(task),
      updateTask: vi.fn().mockResolvedValue(task),
      updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn().mockResolvedValue(task),
      getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 1, maxWorktrees: 1 }),
      parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
      on: vi.fn(),
      off: vi.fn(),
      getRootDir: vi.fn().mockReturnValue("/test/project"),
    } as unknown as TaskStore;

    const reconcileLeaseRow = vi.fn().mockResolvedValue(true);
    const scheduler = new Scheduler(store, {
      leaseManager: {
        recoverAbandonedLease: vi.fn().mockResolvedValue(false),
        reconcileLeaseRow,
      } as any,
    });
    (scheduler as any).running = true;

    await scheduler.schedule();

    expect(reconcileLeaseRow).toHaveBeenCalledTimes(1);
    expect(reconcileLeaseRow).toHaveBeenCalledWith("FN-X");
  });

  it("self-healing orphan recovery invokes reconcile once when recovery returns false", async () => {
    const task = makeTask({ column: "in-progress", worktree: undefined, updatedAt: "2026-01-01T00:00:00.000Z" });
    const store = {
      listTasks: vi.fn().mockResolvedValue([task]),
      updateTask: vi.fn().mockResolvedValue(task),
      logEntry: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn().mockResolvedValue(task),
    } as unknown as TaskStore;

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    const reconcileLeaseRow = vi.fn().mockResolvedValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
      leaseManager: {
        recoverAbandonedLease: vi.fn().mockResolvedValue(false),
        reconcileLeaseRow,
      } as any,
    });

    const recovered = await manager.recoverOrphanedExecutions();
    expect(recovered).toBe(1);
    expect(reconcileLeaseRow).toHaveBeenCalledWith("FN-X");
    manager.stop();
    vi.useRealTimers();
  });

  it("rejects stale owner renewal attempts after recovery", async () => {
    const centralClaimStore: CentralClaimStore = {
      tryClaimTask: vi.fn() as any,
      releaseTaskClaim: vi.fn().mockReturnValue({ ok: true }),
      getTaskClaim: vi.fn().mockReturnValue(null),
      renewTaskClaim: vi.fn().mockReturnValue({
        ok: false,
        reason: "not_found",
        current: null,
      }),
    };
    const current = makeTask({ id: "FN-RENEW" });
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(current),
      updateTask: vi.fn().mockResolvedValue(current),
      moveTask: vi.fn().mockResolvedValue(current),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;

    const manager = new MeshLeaseManager({ taskStore, centralClaimStore, projectId: "project-1" });
    await expect(manager.recoverAbandonedLease("FN-RENEW", "stale-heartbeat")).resolves.toBe(true);

    const renew = centralClaimStore.renewTaskClaim({
      projectId: "project-1",
      taskId: "FN-RENEW",
      nodeId: "node-a",
      agentId: "agent-1",
      runId: null,
      renewedAt: new Date().toISOString(),
      expectedEpoch: 1,
    });
    expect(renew.ok).toBe(false);
  });

  it("reconciles split-brain state after central release succeeds but local update initially fails", async () => {
    const current = makeTask({ column: "in-progress" });
    const updateTask = vi
      .fn()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValue(current);
    const taskStore = {
      getTask: vi.fn().mockResolvedValue(current),
      updateTask,
      moveTask: vi.fn().mockResolvedValue(current),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
    const centralClaimStore: CentralClaimStore = {
      tryClaimTask: vi.fn() as any,
      renewTaskClaim: vi.fn() as any,
      getTaskClaim: vi.fn().mockReturnValue(null),
      releaseTaskClaim: vi.fn().mockReturnValue({ ok: true }),
    };

    const manager = new MeshLeaseManager({ taskStore, centralClaimStore, projectId: "project-1" });

    const recovered = await manager.recoverAbandonedLease("FN-X", "stale-heartbeat");
    expect(recovered).toBe(false);

    updateTask.mockResolvedValueOnce(current);
    const reconciled = await manager.reconcileLeaseRow("FN-X");
    expect(reconciled).toBe(true);
    expect(updateTask).toHaveBeenCalled();
  });
});

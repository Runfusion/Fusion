import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { MeshLeaseManager } from "../mesh-lease-manager.js";

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    description: "handoff",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    checkedOutBy: "agent-1",
    checkedOutAt: "2026-01-01T00:00:00.000Z",
    checkoutLeaseRenewedAt: "2026-01-01T00:00:00.000Z",
    checkoutLeaseEpoch: 1,
    checkoutNodeId: "node-owner",
    ...overrides,
  };
}

function createTaskStore(task: Task) {
  let current = { ...task };
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
    current = { ...current, ...patch };
    return current;
  });
  const taskStore = {
    getTask: vi.fn(async () => current),
    updateTask,
    moveTask: vi.fn(async () => current),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;
  return { taskStore, updateTask, getCurrent: () => current };
}

describe("MeshLeaseManager owning-node handoff integration", () => {
  it.each([
    { policy: "block", selfOwned: false, expectRecovered: false },
    { policy: "reassign-to-local", selfOwned: false, expectRecovered: true },
    { policy: "reassign-any-healthy", selfOwned: false, expectRecovered: true },
    { policy: "block", selfOwned: true, expectRecovered: true },
    { policy: "reassign-to-local", selfOwned: true, expectRecovered: true },
    { policy: "reassign-any-healthy", selfOwned: true, expectRecovered: true },
  ] as const)("policy=$policy selfOwned=$selfOwned", async ({ policy, selfOwned, expectRecovered }) => {
    const ownerNodeId = selfOwned ? "node-local" : "node-owner";
    const { taskStore, updateTask, getCurrent } = createTaskStore(baseTask({ checkoutNodeId: ownerNodeId }));

    const manager = new MeshLeaseManager({
      taskStore,
      nodeHealthMonitor: { getNodeHealth: vi.fn(() => "offline") } as any,
      localNodeId: "node-local",
      getHandoffPolicy: async () => policy,
    });

    const recovered = await manager.recoverAbandonedLease("FN-1", "test");
    expect(recovered).toBe(expectRecovered);

    if (expectRecovered) {
      expect(updateTask).toHaveBeenCalled();
      expect(getCurrent().checkedOutBy).toBeNull();
      expect(getCurrent().checkoutNodeId).toBeNull();
    } else {
      expect(updateTask).not.toHaveBeenCalled();
      expect(getCurrent().checkedOutBy).toBe("agent-1");
    }
  });
});

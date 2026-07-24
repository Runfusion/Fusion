import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import type { NodeStatus, OwningNodeHandoffPolicy, Task, TaskStore } from "@fusion/core";
import { TaskStore as CoreTaskStore } from "@fusion/core";
import { MeshLeaseManager } from "../../mesh-lease-manager.js";
import { Scheduler } from "../../scheduler.js";
import { hasGit, hasPg, makePgTaskStore } from "./_helpers.js";

const describeIfGit = hasGit && hasPg ? describe : describe.skip;
const readFileState = vi.hoisted(() => ({ mockPromptRead: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => (
      readFileState.mockPromptRead ? "# Task\nFN-4813" : actual.readFile(...args)
    ),
  };
});

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-200",
    description: "scheduler handoff",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    prompt: "",
    ...overrides,
  } as Task;
}

function createMockStore(task: Task, settings: Record<string, unknown> = {}): TaskStore {
  const moveTask = vi.fn().mockResolvedValue(undefined);
  return {
    listTasks: vi.fn().mockResolvedValue([task]),
    getSettings: vi.fn().mockResolvedValue(settings),
    /*
    FNXC:EngineTests 2026-06-27-10:05:
    Scheduler reliability fakes must expose the production `updateSettings` heartbeat write so owning-node handoff invariants run before call-count assertions.
    */
    updateSettings: vi.fn().mockResolvedValue(settings),
    getTask: vi.fn().mockResolvedValue(task),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask,
    /*
    FNXC:EngineTests 2026-07-23-21:20:
    Scheduler dispatch now goes through the atomic `moveTaskIf` (user-paused dispatch fix, commit 0818fc1da).
    The fake delegates to the mock `moveTask` after the predicate passes so existing dispatch assertions on `store.moveTask` stay meaningful.
    */
    moveTaskIf: vi.fn(async (id: string, column: Task["column"], predicate: (live: Task) => boolean | Promise<boolean>, opts?: Record<string, unknown>) => {
      if (!(await predicate(task)) || task.column === column) return { task, moved: false };
      await moveTask(id, column, opts);
      task.column = column;
      return { task, moved: true };
    }),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/tmp/test"),
    getTasksDir: vi.fn().mockReturnValue("/tmp/test/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function createMockHealthMonitor(statusMap: Record<string, NodeStatus | undefined>) {
  return {
    getNodeHealth: vi.fn((id: string) => statusMap[id]),
  } as unknown as import("../../node-health-monitor.js").NodeHealthMonitor;
}

describeIfGit("reliability interactions: owning-node unavailable handoff", () => {
  let taskStore: CoreTaskStore;
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const fixture = await makePgTaskStore();
    taskStore = fixture.store;
    cleanup = fixture.cleanup;
    readFileState.mockPromptRead = true;
  });

  afterEach(async () => {
    readFileState.mockPromptRead = false;
    await cleanup?.();
  });

  async function seedCheckedOutTask(overrides: Partial<Task> = {}): Promise<Task> {
    const created = await taskStore.createTask({ description: "FN-4813 owning-node handoff" });
    return taskStore.updateTask(created.id, {
      column: "todo",
      checkedOutBy: "agent-1",
      checkedOutAt: new Date().toISOString(),
      checkoutNodeId: "node-a",
      checkoutRunId: "run-a-1",
      checkoutLeaseRenewedAt: new Date().toISOString(),
      checkoutLeaseEpoch: 1,
      ...overrides,
    });
  }

  it.each(["block", "reassign-to-local", "reassign-any-healthy"] as const)(
    "FN-4813: owner online never auto-steals lease (policy=%s)",
    async (policy) => {
      const task = await seedCheckedOutTask({
        checkedOutAt: new Date().toISOString(),
        checkoutLeaseRenewedAt: new Date().toISOString(),
      });
      const manager = new MeshLeaseManager({
        taskStore,
        nodeHealthMonitor: { getNodeHealth: () => "online" } as any,
        getHandoffPolicy: async () => policy,
        localNodeId: "node-local",
      });

      const recovered = await manager.recoverAbandonedLease(task.id, "scheduler detected stale todo lease");
      expect(recovered).toBe(false);

      const persisted = await taskStore.getTask(task.id);
      expect(persisted?.checkedOutBy).toBe("agent-1");
      expect(persisted?.checkoutNodeId).toBe("node-a");
      expect(persisted?.checkoutLeaseEpoch).toBe(1);
    },
  );

  it("FN-4813: owner offline + block policy parks lease", async () => {
    const task = await seedCheckedOutTask();
    const manager = new MeshLeaseManager({
      taskStore,
      nodeHealthMonitor: { getNodeHealth: () => "offline" } as any,
      getHandoffPolicy: async () => "block",
      localNodeId: "node-local",
    });

    const recovered = await manager.recoverAbandonedLease(task.id, "scheduler detected stale todo lease");
    expect(recovered).toBe(false);

    const persisted = await taskStore.getTask(task.id);
    expect(persisted?.checkedOutBy).toBe("agent-1");
    expect(persisted?.checkoutNodeId).toBe("node-a");
    expect(persisted?.checkoutLeaseEpoch).toBe(1);
    expect(persisted?.checkoutRunId).toBe("run-a-1");
  });

  it.each(["reassign-to-local", "reassign-any-healthy"] as const)(
    "FN-4813: owner offline + policy=%s clears lease with epoch bump",
    async (policy) => {
      const task = await seedCheckedOutTask({ checkoutNodeId: "node-a" });
      const manager = new MeshLeaseManager({
        taskStore,
        nodeHealthMonitor: { getNodeHealth: () => "offline" } as any,
        getHandoffPolicy: async () => policy,
        localNodeId: "node-local",
      });

      const recovered = await manager.recoverAbandonedLease(task.id, "scheduler detected stale todo lease");
      expect(recovered).toBe(true);

      const persisted = await taskStore.getTask(task.id);
      expect(persisted?.checkedOutBy ?? null).toBeNull();
      expect(persisted?.checkoutNodeId ?? null).toBeNull();
      expect(persisted?.checkoutRunId ?? null).toBeNull();
      expect(persisted?.checkoutLeaseRenewedAt ?? null).toBeNull();
      expect(persisted?.checkoutLeaseEpoch).toBe(2);
    },
  );

  it.each(["block", "reassign-to-local", "reassign-any-healthy"] as const)(
    "FN-4813: self-owned offline recovery ignores policy and clears lease (policy=%s)",
    async (policy) => {
      const task = await seedCheckedOutTask({ checkoutNodeId: "node-local" });
      const manager = new MeshLeaseManager({
        taskStore,
        nodeHealthMonitor: { getNodeHealth: () => "offline" } as any,
        getHandoffPolicy: async () => policy,
        localNodeId: "node-local",
      });

      const recovered = await manager.recoverAbandonedLease(task.id, "scheduler detected stale todo lease");
      expect(recovered).toBe(true);

      const persisted = await taskStore.getTask(task.id);
      expect(persisted?.checkedOutBy ?? null).toBeNull();
      expect(persisted?.checkoutNodeId ?? null).toBeNull();
      expect(persisted?.checkoutLeaseEpoch).toBe(2);
    },
  );

  it("FN-4813: owner returning online during recovery window parks handoff", async () => {
    const task = await seedCheckedOutTask();
    let calls = 0;
    const manager = new MeshLeaseManager({
      taskStore,
      nodeHealthMonitor: {
        getNodeHealth: () => {
          calls += 1;
          return calls === 1 ? "offline" : "online";
        },
      } as any,
      getHandoffPolicy: async () => "reassign-to-local",
      localNodeId: "node-local",
    });

    const recovered = await manager.recoverAbandonedLease(task.id, "scheduler detected stale todo lease");
    expect(recovered).toBe(false);

    const persisted = await taskStore.getTask(task.id);
    expect(persisted?.checkedOutBy).toBe("agent-1");
    expect(persisted?.checkoutNodeId).toBe("node-a");
    expect(persisted?.checkoutLeaseEpoch).toBe(1);
  });

  it("FN-4813: scheduler does not apply owning-node handoff when owner is online", async () => {
    const task = createMockTask({
      id: "FN-201",
      checkedOutBy: "agent-1",
      checkoutNodeId: "node-a",
      checkoutLeaseEpoch: 1,
      nodeId: "node-b",
    });
    const store = createMockStore(task, { maxConcurrent: 1, maxWorktrees: 1, owningNodeHandoffPolicy: "reassign-to-local" });
    const reconcileLeaseRow = vi.fn().mockResolvedValue(false);
    const scheduler = new Scheduler(store, {
      leaseManager: {
        recoverAbandonedLease: vi.fn().mockResolvedValue(false),
        reconcileLeaseRow,
      } as any,
      nodeHealthMonitor: createMockHealthMonitor({ "node-a": "online", "node-b": "online" }),
      validateNodeDispatch: vi.fn().mockResolvedValue({ allowed: true }),
    });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.logEntry).not.toHaveBeenCalledWith(task.id, expect.stringContaining("Owning-node handoff applied"));
    expect(reconcileLeaseRow).toHaveBeenCalledTimes(1);
    expect(reconcileLeaseRow).toHaveBeenCalledWith(task.id);
    expect(store.updateTask).toHaveBeenCalledWith(task.id, { status: "queued" });
  });

  it("FN-4813: scheduler reassigns local dispatch when owner offline and policy is reassign-to-local", async () => {
    const task = createMockTask({
      id: "FN-202",
      checkedOutBy: "agent-1",
      checkoutNodeId: "node-a",
      checkoutLeaseEpoch: 1,
      nodeId: "node-b",
    });
    const store = createMockStore(task, {
      maxConcurrent: 1,
      maxWorktrees: 1,
      owningNodeHandoffPolicy: "reassign-to-local" satisfies OwningNodeHandoffPolicy,
      unavailableNodePolicy: "block",
    });
    const scheduler = new Scheduler(store, {
      leaseManager: { recoverAbandonedLease: vi.fn().mockResolvedValue(true), reconcileLeaseRow: vi.fn() } as any,
      nodeHealthMonitor: createMockHealthMonitor({ "node-a": "offline", "node-b": "online" }),
      validateNodeDispatch: vi.fn().mockResolvedValue({ allowed: true }),
    });
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("Owning-node handoff applied"));
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "in-progress", expect.any(Object));
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ effectiveNodeId: "node-b" }));
  });
});

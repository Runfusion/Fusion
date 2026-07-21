import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../active-session-registry.js";
import { SelfHealingManager } from "../self-healing.js";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "triage",
    status: null,
    paused: false,
    worktree: `/tmp/${id}`,
    workflowIrPinNodeId: "code-review-remediation",
    workflowIrPinColumnId: "in-progress",
    dependencies: [],
    steps: [{ name: "Fix review", status: "pending" }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function storeFor(tasks: Task[]): TaskStore & EventEmitter {
  const rows = new Map(tasks.map((entry) => [entry.id, entry]));
  return Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false }) as Settings),
    listTasks: vi.fn(async () => [...rows.values()]),
    getTask: vi.fn(async (id: string) => rows.get(id)),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = rows.get(id)!;
      rows.set(id, { ...current, column });
      return rows.get(id);
    }),
    moveTaskIf: vi.fn(async (
      id: string,
      column: Task["column"],
      predicate: (live: Task) => boolean | Promise<boolean>,
    ) => {
      const current = rows.get(id)!;
      if (!await predicate(current)) return { task: current, moved: false };
      const moved = { ...current, column } as Task;
      rows.set(id, moved);
      return { task: moved, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

describe("advanced workflow tasks stranded in triage", () => {
  beforeEach(() => activeSessionRegistry.clear());

  it("resumes incomplete remediation at its durable pinned column", async () => {
    const stranded = task("FN-INCOMPLETE");
    const store = storeFor([stranded]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      getExecutingTaskIds: () => new Set<string>(),
    });

    expect(await manager.recoverAdvancedTriageTasks()).toBe(1);
    expect(store.moveTaskIf).toHaveBeenCalledWith(
      stranded.id,
      "in-progress",
      expect.any(Function),
      expect.objectContaining({
        recoveryRehome: true,
        preserveProgress: true,
        preserveWorktree: true,
        workflowMoveSource: "self-healing-advanced-triage",
      }),
    );
  });

  it("promotes completed pinned work through the normal completion recovery seam", async () => {
    const stranded = task("FN-COMPLETE", {
      workflowIrPinNodeId: "merge",
      workflowIrPinColumnId: undefined,
      steps: [{ name: "Implement", status: "done" }],
    });
    const store = storeFor([stranded]);
    const recoverCompletedTask = vi.fn(async () => true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      recoverCompletedTask,
      getExecutingTaskIds: () => new Set<string>(),
    });

    expect(await manager.recoverAdvancedTriageTasks()).toBe(1);
    expect(recoverCompletedTask).toHaveBeenCalledWith(stranded);
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  it("clears a stale same-task session-path claim before promoting completed pinned work", async () => {
    const stranded = task("FN-STALE-REGISTRY", {
      workflowIrPinNodeId: "merge",
      workflowIrPinColumnId: undefined,
      steps: [{ name: "Implement", status: "done" }],
    });
    const store = storeFor([stranded]);
    const recoverCompletedTask = vi.fn(async () => true);
    activeSessionRegistry.registerPath(stranded.worktree!, {
      taskId: stranded.id,
      kind: "workflow-step",
      ownerKey: `${stranded.id}#stale`,
    });
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      recoverCompletedTask,
      getExecutingTaskIds: () => new Set<string>(),
      getPlanningTaskIds: () => new Set<string>(),
      isTaskActive: () => false,
    });

    expect(await manager.recoverAdvancedTriageTasks()).toBe(1);
    expect(recoverCompletedTask).toHaveBeenCalledWith(stranded);
    expect(activeSessionRegistry.isPathActive(stranded.worktree!)).toBe(false);
  });

  it("leaves ordinary planning rows and actively-owned graph runs untouched", async () => {
    const ordinary = task("FN-ORDINARY", { worktree: undefined, workflowIrPinNodeId: undefined });
    const active = task("FN-ACTIVE");
    const store = storeFor([ordinary, active]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      getExecutingTaskIds: () => new Set([active.id]),
    });

    expect(await manager.recoverAdvancedTriageTasks()).toBe(0);
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  it("does not rehome a task claimed after discovery but before the atomic move", async () => {
    const stranded = task("FN-RACING-CLAIM");
    const store = storeFor([stranded]);
    let claimed = false;
    const moveTaskIfMock = vi.mocked(store.moveTaskIf);
    const moveTaskIf = moveTaskIfMock.getMockImplementation()!;
    moveTaskIfMock.mockImplementation(async (...args) => {
      claimed = true;
      return moveTaskIf(...args);
    });
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      getExecutingTaskIds: () => claimed ? new Set([stranded.id]) : new Set<string>(),
    });

    expect(await manager.recoverAdvancedTriageTasks()).toBe(0);
    expect(store.moveTaskIf).toHaveBeenCalledOnce();
  });

  it("does not promote completed work when planning wins the ownership reservation", async () => {
    const stranded = task("FN-COMPLETED-RACING-CLAIM", {
      workflowIrPinNodeId: "merge",
      workflowIrPinColumnId: undefined,
      steps: [{ name: "Implement", status: "done" }],
    });
    const store = storeFor([stranded]);
    const recoverCompletedTask = vi.fn(async () => true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      recoverCompletedTask,
      getExecutingTaskIds: () => new Set<string>(),
      reserveAdvancedTriageRecovery: () => undefined,
    });

    expect(await manager.recoverAdvancedTriageTasks()).toBe(0);
    expect(recoverCompletedTask).not.toHaveBeenCalled();
  });

  it("releases the planning fence after completed recovery", async () => {
    const stranded = task("FN-COMPLETED-RESERVED", {
      workflowIrPinNodeId: "merge",
      workflowIrPinColumnId: undefined,
      steps: [{ name: "Implement", status: "done" }],
    });
    const store = storeFor([stranded]);
    const release = vi.fn();
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      recoverCompletedTask: vi.fn(async () => true),
      getExecutingTaskIds: () => new Set<string>(),
      reserveAdvancedTriageRecovery: () => release,
    });

    expect(await manager.recoverAdvancedTriageTasks()).toBe(1);
    expect(release).toHaveBeenCalledOnce();
  });
});

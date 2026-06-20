import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { TaskExecutor } from "../executor.js";
import { activeSessionRegistry, executingTaskLock } from "../active-session-registry.js";

function task(overrides: Partial<Task>): Task {
  return {
    id: "FN-T",
    description: "test",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    prompt: "",
    ...overrides,
  } as Task;
}

function createStore(initialTasks: Task[], settings: Partial<Settings> = {}): { store: TaskStore & EventEmitter; tasks: Map<string, Task> } {
  const tasks = new Map(initialTasks.map((entry) => [entry.id, entry]));
  const emitter = new EventEmitter();
  const store = Object.assign(emitter, {
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, autoMerge: true, ...settings }),
    listTasks: vi.fn(async () => [...tasks.values()]),
    moveTask: vi.fn(async (taskId: string, column: Task["column"]) => {
      const current = tasks.get(taskId);
      if (!current) throw new Error(`missing ${taskId}`);
      const updated = { ...current, column } as Task;
      tasks.set(taskId, updated);
      return updated;
    }),
    updateTask: vi.fn(async (taskId: string, updates: Partial<Task>) => {
      const current = tasks.get(taskId);
      if (!current) throw new Error(`missing ${taskId}`);
      const updated = { ...current, ...updates } as Task;
      tasks.set(taskId, updated);
      return updated;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getCompletionHandoffAcceptedMarker: vi.fn().mockReturnValue(null),
    getTask: vi.fn(async (taskId: string) => tasks.get(taskId) ?? task({ id: taskId })),
  }) as unknown as TaskStore & EventEmitter;
  return { store, tasks };
}

describe("executor dependency dispatch gate", () => {
  afterEach(() => {
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
  });

  it("blocks workflow graph and authoritative dispatch before unmet dependencies can advance", async () => {
    const dependent = task({ id: "FN-DISPATCH", column: "in-progress", dependencies: ["FN-DEP"] });
    const { store } = createStore([
      dependent,
      task({ id: "FN-DEP", column: "todo" }),
    ]);
    const workflowAuthoritativeDispatch = vi.fn().mockResolvedValue(true);
    const executor = new TaskExecutor(store, "/tmp/test-project", { workflowAuthoritativeDispatch });
    const graphDispatch = vi.spyOn(executor as any, "maybeExecuteWorkflowGraph").mockResolvedValue(true);

    await executor.execute(dependent);

    expect(graphDispatch).not.toHaveBeenCalled();
    expect(workflowAuthoritativeDispatch).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-DISPATCH", "todo", expect.objectContaining({
      preserveProgress: true,
      preserveWorktree: true,
      preserveResumeState: true,
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-DISPATCH", { status: "queued", blockedBy: "FN-DEP" }, undefined);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-DISPATCH",
      "queued — unmet dependencies: FN-DEP",
      expect.stringContaining("blocked workflow/authoritative execution"),
      undefined,
    );
  });
});

describe("in-review unmet dependency reconciliation", () => {
  afterEach(() => {
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
  });

  it("reproduces FN-6778/FN-6779 review advancement and rebounds to queued todo", async () => {
    const { store, tasks } = createStore([
      task({ id: "FN-6778", column: "in-review", dependencies: ["FN-6777"] }),
      task({ id: "FN-6777", column: "in-progress" }),
      task({ id: "FN-6779", column: "in-review", dependencies: ["FN-6770", "FN-6771", "FN-6780", "FN-TRIAGE"] }),
      task({ id: "FN-6770", column: "in-progress" }),
      task({ id: "FN-6771", column: "todo" }),
      task({ id: "FN-6780", column: "todo", status: "queued" }),
      task({ id: "FN-TRIAGE", column: "triage" }),
    ]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await expect(manager.reconcileInReviewUnmetDependencies()).resolves.toBe(2);

    expect(tasks.get("FN-6778")).toMatchObject({ column: "todo", status: "queued", blockedBy: "FN-6777" });
    expect(tasks.get("FN-6779")).toMatchObject({ column: "todo", status: "queued", blockedBy: "FN-6770" });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reconcile-in-review-unmet-dependencies",
      target: "FN-6778",
      metadata: expect.objectContaining({ unmetDeps: ["FN-6777"] }),
    }));
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reconcile-in-review-unmet-dependencies",
      target: "FN-6779",
      metadata: expect.objectContaining({ unmetDeps: ["FN-6770", "FN-6771", "FN-6780", "FN-TRIAGE"] }),
    }));
    manager.stop();
  });
});

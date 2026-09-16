import { describe, expect, it, vi } from "vitest";
import { TaskDeletedError, TaskNotFoundError, type TaskStore } from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import { schedulerLog } from "../logger.js";
import { SelfHealingManager } from "../self-healing.js";
import { flushAsyncHandlers } from "./_flush-async-handlers.js";

function task(id: string, dependencies: string[], extra: Record<string, unknown> = {}) {
  return { id, dependencies, column: "todo", autoMerge: true, ...extra };
}

function createSchedulerListenerStore() {
  const listeners = new Map<string, ((payload: any, meta?: any) => void)[]>();
  const store = {
    on: vi.fn((event: string, listener: (payload: any, meta?: any) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    off: vi.fn(),
    getRootDir: vi.fn(() => "/test/project"),
    getSettings: vi.fn().mockResolvedValue({}),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;
  return {
    store,
    emit: (event: string, payload: any, meta?: any) => {
      for (const listener of listeners.get(event) ?? []) listener(payload, meta);
    },
  };
}

describe("terminal task maintenance containment", () => {
  it.each([
    ["unpause wake", [{ paused: true, userPaused: true }, { paused: false, userPaused: false }]],
    ["planning-complete wake", [{ status: "planning" }, { status: undefined }]],
    ["approval-release wake", [{ status: "awaiting-approval" }, { status: undefined, approvedPlanFingerprint: "approved" }]],
  ])("Scheduler contains %s listener rejection", async (_name, updates) => {
    const { store, emit } = createSchedulerListenerStore();
    (store.getTaskWorkflowSelectionAsync as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Task KB-031 is archived — logging is read-only"));
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = false;
    const unhandled: unknown[] = [];
    const capture = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", capture);
    try {
      for (const update of updates) {
        emit("task:updated", task("KB-031", [], { ...update, columnMovedAt: "2026-09-15T00:00:00.000Z" }));
      }
      await flushAsyncHandlers();
    } finally {
      process.off("unhandledRejection", capture);
    }
    expect(unhandled).toEqual([]);
    expect((store.getTaskWorkflowSelectionAsync as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("Scheduler contains one failed deleted-task dependent while repairing a healthy dependent", async () => {
    const { store, emit } = createSchedulerListenerStore();
    const failing = task("KB-032", ["KB-031"], { blockedBy: "KB-031" });
    const healthy = task("KB-033", ["KB-031"], { blockedBy: "KB-031" });
    (store.getTaskWorkflowSelectionAsync as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(async ({ column }: { column: string }) =>
      column === "todo" ? [failing, healthy] : [],
    );
    (store.getTask as ReturnType<typeof vi.fn>) = vi.fn().mockResolvedValue(task("KB-031", [], { column: "done" }));
    (store.updateTask as ReturnType<typeof vi.fn>) = vi.fn((id: string) => id === "KB-032"
      ? Promise.reject(new Error("storage unavailable"))
      : Promise.resolve(undefined));
    (store.logEntry as ReturnType<typeof vi.fn>) = vi.fn().mockResolvedValue(undefined);
    const error = vi.spyOn(schedulerLog, "error").mockImplementation(() => {});
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = false;
    const unhandled: unknown[] = [];
    const capture = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", capture);
    try {
      emit("task:deleted", task("KB-031", []));
      await flushAsyncHandlers(100);
    } finally {
      process.off("unhandledRejection", capture);
    }

    expect(unhandled).toEqual([]);
    expect(error.mock.calls.map(([message, cause]) => [message, cause instanceof Error ? cause.message : cause])).toEqual([
      ["Failed to reconcile dependent KB-032 for soft-deleted blocker KB-031", "storage unavailable"],
    ]);
    expect(store.updateTask).toHaveBeenCalledWith("KB-033", expect.objectContaining({ blockedBy: null }));
    expect(store.logEntry).toHaveBeenCalledWith("KB-033", expect.stringContaining("Auto-unblocked"));
  });

  it("contains a deleted-row trailing log refusal and continues to a healthy dependency repair", async () => {
    const deletedDuringLog = task("KB-031", ["MISSING-A"]);
    const healthy = task("KB-032", ["MISSING-B"]);
    const store = {
      listTasks: vi.fn().mockResolvedValue([deletedDuringLog, healthy]),
      getTask: vi.fn((id: string) => {
        if (id === "MISSING-A" || id === "MISSING-B") return Promise.reject(new TaskNotFoundError(id));
        return Promise.resolve(id === "KB-031" ? deletedDuringLog : healthy);
      }),
      updateTaskDependencies: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn((id: string) => id === "KB-031"
        ? Promise.reject(new TaskDeletedError(id, "2026-09-15T00:00:00.000Z"))
        : Promise.resolve(undefined)),
    };
    const manager = new SelfHealingManager(store as any, { rootDir: "/repo", getExecutingTaskIds: () => new Set() });

    await expect(manager.reconcileMissingDependencies()).resolves.toBe(1);

    expect(store.updateTaskDependencies).toHaveBeenCalledWith("KB-031", { operation: "remove", dependency: "MISSING-A" });
    expect(store.updateTaskDependencies).toHaveBeenCalledWith("KB-032", { operation: "remove", dependency: "MISSING-B" });
    expect(store.logEntry).toHaveBeenCalledWith("KB-032", expect.any(String));
  });

  it("reports a storage failure without preventing a later maintenance candidate", async () => {
    const failing = task("KB-033", ["MISSING-C"]);
    const healthy = task("KB-034", ["MISSING-D"]);
    const store = {
      listTasks: vi.fn().mockResolvedValue([failing, healthy]),
      getTask: vi.fn((id: string) => {
        if (id.startsWith("MISSING")) return Promise.reject(new TaskNotFoundError(id));
        return Promise.resolve(id === "KB-033" ? failing : healthy);
      }),
      updateTaskDependencies: vi.fn((id: string) => id === "KB-033"
        ? Promise.reject(new Error("storage unavailable"))
        : Promise.resolve(undefined)),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new SelfHealingManager(store as any, { rootDir: "/repo", getExecutingTaskIds: () => new Set() });

    await expect(manager.reconcileMissingDependencies()).resolves.toBe(1);
    expect(store.updateTaskDependencies).toHaveBeenCalledWith("KB-034", { operation: "remove", dependency: "MISSING-D" });
  });
});

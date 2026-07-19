import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { executingTaskLock } from "../active-session-registry.js";
import { executorLog } from "../logger.js";
import * as childProcess from "node:child_process";
import { resetExecutorMocks } from "./executor-test-helpers.js";

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? null,
    description: overrides.description ?? "desc",
    status: overrides.status ?? "open",
    column: overrides.column ?? "in-progress",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    dependencies: overrides.dependencies ?? [],
    comments: overrides.comments ?? [],
    steps: overrides.steps ?? [],
    currentStep: overrides.currentStep ?? 0,
    log: overrides.log ?? [],
    assignedAgentId: overrides.assignedAgentId,
    checkedOutBy: overrides.checkedOutBy,
    checkoutLeaseEpoch: overrides.checkoutLeaseEpoch,
    paused: overrides.paused,
    deletedAt: overrides.deletedAt,
  } as unknown as Task;
}

function createStore(overrides?: { tasks?: Task[] }) {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const store = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    off: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue(overrides?.tasks ?? []),
    /*
    FNXC:EngineTests 2026-07-17-06:20:
    Graph entry captures a tool-failure log cursor (getAgentLogCount + updateTask) before the
    soft-delete short-circuit. Stub both so execute() can reach the deletedAt refuse path.
    */
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue({}),
  } as any;
  return store;
}

describe("TaskExecutor soft-delete guards", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("refuses to execute soft-deleted tasks even when checked out and releases execution lock", async () => {
    const store = createStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const warnSpy = vi.spyOn(executorLog, "warn");
    const execSyncSpy = vi.spyOn(childProcess, "execSync");

    const task = makeTask({
      id: "FN-5137",
      checkedOutBy: "agent-1",
      checkoutLeaseEpoch: 2,
      deletedAt: "2026-01-02T00:00:00.000Z",
    });
    await executor.execute(task);

    expect(execSyncSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("FN-5137: refusing execute — task is soft-deleted");
    expect(executingTaskLock.tryClaim(task.id)).toBe(true);
    executingTaskLock.release(task.id);
  });

  it("resumeTaskForAgent skips checked-out soft-deleted tasks", async () => {
    const deletedTask = makeTask({
      id: "FN-assigned-deleted",
      column: "in-progress",
      assignedAgentId: "agent-1",
      checkedOutBy: "agent-1",
      checkoutLeaseEpoch: 3,
      paused: false,
      deletedAt: "2026-01-03T00:00:00.000Z",
    });
    const store = createStore({ tasks: [deletedTask] });
    const executor = new TaskExecutor(store, "/tmp/test");
    const executeSpy = vi.spyOn(executor, "execute");

    await executor.resumeTaskForAgent("agent-1");

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("resumeOrphaned skips checked-out soft-deleted in-progress tasks", async () => {
    const deletedTask = makeTask({
      id: "FN-deleted",
      column: "in-progress",
      checkedOutBy: "agent-1",
      checkoutLeaseEpoch: 4,
      paused: false,
      deletedAt: "2026-01-03T00:00:00.000Z",
    });
    const store = createStore({ tasks: [deletedTask] });
    const executor = new TaskExecutor(store, "/tmp/test");
    const executeSpy = vi.spyOn(executor, "execute");

    await executor.resumeOrphaned();

    expect(executeSpy).not.toHaveBeenCalled();
  });
});

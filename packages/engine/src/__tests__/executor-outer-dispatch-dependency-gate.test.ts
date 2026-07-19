import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  AgentSemaphore,
  clearPreHeldExecutorSlotsForTests,
  hasPreHeldExecutorSlot,
  registerPreHeldExecutorSlot,
} from "../concurrency.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:DependencyGating 2026-07-16-00:00:
The scheduler is not the only route into TaskExecutor.execute(): graph, workflow-authoritative,
and legacy work-engine dispatch can enter its outer boundary directly. This regression suite
keeps the shared scheduler helper authoritative there too: unknown, archived, and soft-deleted
residue remains non-blocking; live dependencies requeue before every downstream surface; and
completion-handoff markers are observed only for shadow parity, never used to override legacy
scheduling eligibility.
*/

const now = "2026-07-16T00:00:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-CHILD",
    title: "Executor outer dependency gate",
    description: "Regression coverage for non-scheduler dispatch",
    column: "in-progress",
    dependencies: ["FN-PARENT"],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-child",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-child",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    autoMerge: true,
    maxAutoMergeRetries: 3,
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
    ...overrides,
  };
}

function prepareStore(child: TaskDetail, dependencies: TaskDetail[], shadowEnabled = false) {
  const store = createMockStore();
  store.getSettings.mockResolvedValue(settings({ mergeRequestContractShadowEnabled: shadowEnabled }));
  store.listTasks.mockResolvedValue([child, ...dependencies]);
  store.getTask.mockResolvedValue(child);
  store.getCompletionHandoffAcceptedMarker = vi.fn().mockResolvedValue(null);
  return store;
}

function spyOuterDispatch(executor: TaskExecutor, workflowAuthoritativeDispatch = vi.fn().mockResolvedValue(false)) {
  const graph = vi.spyOn(executor as any, "maybeExecuteWorkflowGraph").mockResolvedValue(false);
  const workEngine = vi.spyOn(executor as any, "maybeDispatchWorkflowWorkEngine").mockResolvedValue(true);
  return { graph, workEngine, workflowAuthoritativeDispatch };
}

afterEach(() => {
  clearPreHeldExecutorSlotsForTests();
});

describe("executor outer dispatch dependency gate", () => {
  it("requeues a live dependency before graph, authoritative, or legacy dispatch can run", async () => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: "in-progress", dependencies: [] });
    const store = prepareStore(child, [parent]);
    const workflowAuthoritativeDispatch = vi.fn().mockResolvedValue(false);
    const semaphore = new AgentSemaphore(1);
    expect(semaphore.tryAcquire()).toBe(true);
    registerPreHeldExecutorSlot(child.id);
    expect(hasPreHeldExecutorSlot(child.id)).toBe(true);
    const executor = new TaskExecutor(store, "/tmp/test", { semaphore, workflowAuthoritativeDispatch } as any);
    const { graph, workEngine } = spyOuterDispatch(executor, workflowAuthoritativeDispatch);

    await executor.execute(child);

    expect(store.moveTask).toHaveBeenCalledWith(child.id, "todo", expect.objectContaining({
      preserveProgress: true,
      preserveWorktree: true,
      preserveResumeState: true,
      recoveryRehome: true,
    }));
    expect(store.updateTask).toHaveBeenCalledWith(
      child.id,
      expect.objectContaining({ status: "queued", blockedBy: parent.id }),
      undefined,
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      child.id,
      expect.stringContaining("queued — unmet dependencies: FN-PARENT"),
      expect.stringContaining("dependency gate blocked"),
      undefined,
    );
    expect(graph).not.toHaveBeenCalled();
    expect(workflowAuthoritativeDispatch).not.toHaveBeenCalled();
    expect(workEngine).not.toHaveBeenCalled();
    // FNXC:DependencyGating 2026-07-16-00:00: A dependency-gated outer return
    // must drop the scheduler's reservation because no downstream owner can take it.
    expect(hasPreHeldExecutorSlot(child.id)).toBe(false);
    expect(semaphore.activeCount).toBe(0);
    expect(store.getCompletionHandoffAcceptedMarker).not.toHaveBeenCalled();
  });

  it.each(["todo", "queued", "triage"])("blocks live %s dependencies before any outer dispatch surface", async (column) => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: column as TaskDetail["column"], dependencies: [] });
    const store = prepareStore(child, [parent]);
    const executor = new TaskExecutor(store, "/tmp/test");
    const { graph, workEngine } = spyOuterDispatch(executor);

    await executor.execute(child);

    expect(store.updateTask).toHaveBeenCalledWith(
      child.id,
      expect.objectContaining({ status: "queued", blockedBy: parent.id }),
      undefined,
    );
    expect(graph).not.toHaveBeenCalled();
    expect(workEngine).not.toHaveBeenCalled();
  });

  it.each(["done", "in-review", "archived"])("allows legacy-satisfied %s dependencies past the outer gate", async (column) => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: column as TaskDetail["column"], dependencies: [] });
    const store = prepareStore(child, [parent]);
    const executor = new TaskExecutor(store, "/tmp/test");
    const { graph, workEngine } = spyOuterDispatch(executor);

    await executor.execute(child);

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(child.id, expect.objectContaining({ status: "queued" }), undefined);
    expect(graph).toHaveBeenCalledWith(child);
    expect(workEngine).toHaveBeenCalledWith(child);
  });

  it("allows missing or soft-deleted dependency residue past the outer gate", async () => {
    resetExecutorMocks();
    const child = task();
    const store = prepareStore(child, []);
    const executor = new TaskExecutor(store, "/tmp/test");
    const { graph, workEngine } = spyOuterDispatch(executor);

    await executor.execute(child);

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(graph).toHaveBeenCalledWith(child);
    expect(workEngine).toHaveBeenCalledWith(child);
  });

  it("observes an accepted marker in shadow mode without letting it unblock a live dependency", async () => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: "todo", dependencies: [] });
    const store = prepareStore(child, [parent], true);
    store.getCompletionHandoffAcceptedMarker.mockResolvedValue({ acceptedAt: now });
    const executor = new TaskExecutor(store, "/tmp/test");
    const { graph, workEngine } = spyOuterDispatch(executor);

    await executor.execute(child);

    expect(store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledWith(parent.id);
    expect(store.updateTask).toHaveBeenCalledWith(
      child.id,
      expect.objectContaining({ status: "queued", blockedBy: parent.id }),
      undefined,
    );
    expect(graph).not.toHaveBeenCalled();
    expect(workEngine).not.toHaveBeenCalled();
  });

  it("allows a legacy-satisfied dependency with an accepted marker on the legacy basis", async () => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: "done", dependencies: [] });
    const store = prepareStore(child, [parent], true);
    store.getCompletionHandoffAcceptedMarker.mockResolvedValue({ acceptedAt: now });
    const executor = new TaskExecutor(store, "/tmp/test");
    const { graph, workEngine } = spyOuterDispatch(executor);

    await executor.execute(child);

    expect(store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledWith(parent.id);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(graph).toHaveBeenCalledWith(child);
    expect(workEngine).toHaveBeenCalledWith(child);
  });

  it.each([
    ["empty", []],
    ["undefined", undefined],
  ])("returns before store reads for %s dependencies", async (_label, dependencies) => {
    resetExecutorMocks();
    const child = task({ dependencies });
    const store = createMockStore();
    store.getCompletionHandoffAcceptedMarker = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test");

    expect(await (executor as any).blockOuterDispatchWhenDependenciesUnmet(child)).toBe(false);
    expect(store.getSettings).not.toHaveBeenCalled();
    expect(store.listTasks).not.toHaveBeenCalled();
    expect(store.getCompletionHandoffAcceptedMarker).not.toHaveBeenCalled();
  });

  it("bypasses the outer gate for graph interceptor re-entry that was already gated", async () => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: "in-progress", dependencies: [] });
    const store = prepareStore(child, [parent]);
    const executor = new TaskExecutor(store, "/tmp/test") as any;
    const gate = vi.spyOn(executor, "blockOuterDispatchWhenDependenciesUnmet");
    const workEngine = vi.spyOn(executor, "maybeDispatchWorkflowWorkEngine").mockResolvedValue(true);
    executor.graphCompletionInterceptors.set(child.id, vi.fn());

    await executor.execute(child);

    expect(gate).not.toHaveBeenCalled();
    expect(workEngine).toHaveBeenCalledWith(child);
  });
});

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
The scheduler is not the only route into TaskExecutor.execute(): non-scheduler dispatch
(resume-after-restart, heartbeat re-entry, mission/autopilot, work-engine claim) can enter its
outer boundary directly. This regression suite keeps the shared scheduler helper authoritative
there too: unknown, archived, and soft-deleted residue remains non-blocking; live dependencies
requeue before every downstream surface; and completion-handoff markers are observed only for
shadow parity, never used to override scheduling eligibility.

FNXC:EngineTests 2026-07-19-19:20 (U10b):
The gated surface is now SINGULAR. `maybeExecuteWorkflowGraph` (the boolean "did the graph
claim this task") and the second, legacy implementation path it could decline to are deleted;
`executeCore` routing ends in `executeWorkflowGraph(task)`, and work-engine dispatch moved
INSIDE `runImplementation`, downstream of the graph rather than beside it. The requirement is
unchanged and is what these tests still assert: an unmet live dependency must requeue the task
before ANY execution surface runs, and a satisfied one must let the single surface run.
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

/*
FNXC:EngineTests 2026-07-23-21:25:
executeCore now claims graphRouting before any await and passes `{ alreadyClaimed: true }`
into `executeWorkflowGraph` (FN-8471 overseer-thrash fix, commit 6422cb93a). The "allows"
assertions below match that second positional argument; the gated contract is unchanged.
*/
function spyOuterDispatch(executor: TaskExecutor) {
  const graph = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);
  return { graph };
}

afterEach(() => {
  clearPreHeldExecutorSlotsForTests();
  /*
  FNXC:EngineTests 2026-07-23-21:25:
  executeCore claims the process-wide graphRouting set before calling executeWorkflowGraph
  (FN-8471 fix, commit 6422cb93a). With executeWorkflowGraph mocked, its real `finally` never
  releases the claim, so the shared FN-CHILD id would leak across tests and later dispatches
  would drop as duplicates. Clear the static set between tests (precedent: executor-prompt.test.ts).
  */
  (TaskExecutor as unknown as { processWideGraphRouting: Set<string> }).processWideGraphRouting.clear();
});

describe("executor outer dispatch dependency gate", () => {
  it("requeues a live dependency before any execution surface can run", async () => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: "in-progress", dependencies: [] });
    const store = prepareStore(child, [parent]);
    const semaphore = new AgentSemaphore(1);
    expect(semaphore.tryAcquire()).toBe(true);
    registerPreHeldExecutorSlot(child.id);
    expect(hasPreHeldExecutorSlot(child.id)).toBe(true);
    const executor = new TaskExecutor(store, "/tmp/test", { semaphore } as any);
    const { graph } = spyOuterDispatch(executor);

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
    // FNXC:DependencyGating 2026-07-16-00:00: A dependency-gated outer return
    // must drop the scheduler's reservation because no downstream owner can take it.
    expect(hasPreHeldExecutorSlot(child.id)).toBe(false);
    expect(semaphore.activeCount).toBe(0);
    expect(store.getCompletionHandoffAcceptedMarker).not.toHaveBeenCalled();
  });

  it.each(["todo", "queued", "triage"])("blocks live %s dependencies before the outer dispatch surface", async (column) => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: column as TaskDetail["column"], dependencies: [] });
    const store = prepareStore(child, [parent]);
    const executor = new TaskExecutor(store, "/tmp/test");
    const { graph } = spyOuterDispatch(executor);

    await executor.execute(child);

    expect(store.updateTask).toHaveBeenCalledWith(
      child.id,
      expect.objectContaining({ status: "queued", blockedBy: parent.id }),
      undefined,
    );
    expect(graph).not.toHaveBeenCalled();
  });

  it.each(["done", "in-review", "archived"])("allows satisfied %s dependencies past the outer gate", async (column) => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: column as TaskDetail["column"], dependencies: [] });
    const store = prepareStore(child, [parent]);
    const executor = new TaskExecutor(store, "/tmp/test");
    const { graph } = spyOuterDispatch(executor);

    await executor.execute(child);

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(child.id, expect.objectContaining({ status: "queued" }), undefined);
    expect(graph).toHaveBeenCalledWith(child, { alreadyClaimed: true });
  });

  it("allows missing or soft-deleted dependency residue past the outer gate", async () => {
    resetExecutorMocks();
    const child = task();
    const store = prepareStore(child, []);
    const executor = new TaskExecutor(store, "/tmp/test");
    const { graph } = spyOuterDispatch(executor);

    await executor.execute(child);

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(graph).toHaveBeenCalledWith(child, { alreadyClaimed: true });
  });

  it("observes an accepted marker in shadow mode without letting it unblock a live dependency", async () => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: "todo", dependencies: [] });
    const store = prepareStore(child, [parent], true);
    store.getCompletionHandoffAcceptedMarker.mockResolvedValue({ acceptedAt: now });
    const executor = new TaskExecutor(store, "/tmp/test");
    const { graph } = spyOuterDispatch(executor);

    await executor.execute(child);

    expect(store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledWith(parent.id);
    expect(store.updateTask).toHaveBeenCalledWith(
      child.id,
      expect.objectContaining({ status: "queued", blockedBy: parent.id }),
      undefined,
    );
    expect(graph).not.toHaveBeenCalled();
  });

  it("allows a satisfied dependency with an accepted marker on the column basis", async () => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: "done", dependencies: [] });
    const store = prepareStore(child, [parent], true);
    store.getCompletionHandoffAcceptedMarker.mockResolvedValue({ acceptedAt: now });
    const executor = new TaskExecutor(store, "/tmp/test");
    const { graph } = spyOuterDispatch(executor);

    await executor.execute(child);

    expect(store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledWith(parent.id);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(graph).toHaveBeenCalledWith(child, { alreadyClaimed: true });
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

  /*
  FNXC:WorkflowExecution 2026-07-19-01:30:
  U5d (R9): graph-owned re-entry is signalled by passing an explicit completion
  callback to execute(), not by registering an entry in the deleted
  `graphCompletionInterceptors` Map. The contract under test is unchanged: an inner
  graph implementation call was already dependency-gated by the outer dispatch, so it
  must NOT be re-gated.
  */
  /*
  FNXC:WorkflowExecution 2026-07-19-02:10:
  U5e (R9) — the outer dependency gate belongs to ROUTING (executeCore), not to the
  implementation phase. The graph runner calls `runImplementation` directly after routing has
  already gated the task, so the runner must not re-run the gate — re-gating a task the graph
  already owns would drop a legitimately dispatched run. This replaces the old "re-entry
  bypass" assertion: there is no re-entry into execute() left to bypass, but the invariant it
  protected (implementation phase never re-runs outer gates) is the same.
  */
  it("does not re-run the outer dependency gate when the graph drives the implementation phase", async () => {
    resetExecutorMocks();
    const child = task();
    const parent = task({ id: "FN-PARENT", column: "in-progress", dependencies: [] });
    const store = prepareStore(child, [parent]);
    const executor = new TaskExecutor(store, "/tmp/test") as any;
    const gate = vi.spyOn(executor, "blockOuterDispatchWhenDependenciesUnmet");
    const workEngine = vi.spyOn(executor, "maybeDispatchWorkflowWorkEngine").mockResolvedValue(true);

    /*
    FNXC:EngineTests 2026-07-19-19:20 (U10b):
    `graphCompletion` is now a REQUIRED POSITIONAL parameter of `runImplementation`, not an
    options-bag field: with the legacy fallback deleted every implementation pass is
    graph-owned, so "a run nothing owns the completion of" is no longer constructible.
    */
    await executor.runImplementation(child, vi.fn());

    expect(gate).not.toHaveBeenCalled();
    expect(workEngine).toHaveBeenCalledWith(child);
  });
});

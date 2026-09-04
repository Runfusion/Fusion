import { describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

const now = "2026-08-29T01:50:00.000Z";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-249",
    title: "operator cancellation graph exit",
    description: "Regression coverage for terminal user cancellation.",
    column: "in-review",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    branch: "fusion/FN-249",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-249",
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

const mergePauseAbort = {
  disposition: "failed",
  outcome: "failure",
  interruptedAbortKind: "engine-pause",
  interruptedNodeId: "merge",
  visitedNodeIds: ["merge"],
  context: { "node:merge:value": "aborted" },
} as const;

const cancellationWorkflow: WorkflowIr = {
  version: "v2",
  name: "operator cancellation symptom workflow",
  columns: [{ id: "in-review", name: "Review", traits: [] }],
  nodes: [
    { id: "start", kind: "start" },
    {
      id: "documentation-delivery",
      kind: "optional-group",
      config: {
        name: "Documentation",
        defaultOn: true,
        phase: "pre-merge",
        template: {
          nodes: [{ id: "documentation-step", kind: "prompt", config: { prompt: "Document the task.", toolMode: "readonly" } }],
          edges: [],
        },
      },
    },
    { id: "merge-gate", kind: "merge-attempt", config: { capability: "task-merge" } },
    { id: "end", kind: "end" },
  ],
  edges: [
    { from: "start", to: "documentation-delivery" },
    { from: "documentation-delivery", to: "merge-gate", condition: "failure" },
    { from: "merge-gate", to: "end" },
  ],
};

/*
FNXC:WorkflowLifecycle 2026-08-29-02:26:
FN-249 separates explicit operator withdrawal from generic engine abort provenance. A canceled
in-flight graph may emit its classification breadcrumb, but it must not enter recovery classifiers
that retry merge work or create a failure park; the engine-abort control preserves that recovery.
*/
describe("FN-249 operator cancellation graph exit", () => {
  function makeHarness(overrides: Partial<TaskDetail> = {}) {
    resetExecutorMocks();
    const store = createMockStore();
    const task = makeTask(overrides);
    store.getTask.mockResolvedValue(task);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15_000,
      autoMerge: true,
      maxAutoMergeRetries: 3,
    });
    const executor = new TaskExecutor(store as never, "/tmp/test");
    return { executor, store, task };
  }

  it.each([
    ["review", { column: "in-review", autoMerge: true, status: null, error: null }],
    ["wip with prior failure", { column: "in-progress", autoMerge: false, status: "failed", error: "prior failure" }],
    ["rebound", { column: "todo", autoMerge: true, status: null, error: null }],
  ] as const)("quietly terminates a user-canceled graph in %s before merge retry or a failed park", async (_surface, overrides) => {
    const { executor, store, task } = makeHarness(overrides);
    const retryMerge = vi.spyOn(executor as any, "routeGraphMergeFailureToRetry");
    const activeWorktrees = (executor as any).activeWorktrees as Map<string, Set<string>>;
    activeWorktrees.set(task.id, new Set([task.worktree!]));

    (executor as any).markPausedAborted(task.id, "engine-abort");
    (executor as any).userCanceledTaskIds.add(task.id);

    await (executor as any).handleGraphFailure(task, mergePauseAbort);

    expect(retryMerge).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect((executor as any).pausedAborted.has(task.id)).toBe(false);
    expect(activeWorktrees.has(task.id)).toBe(false);
    expect((executor as any).userCanceledTaskIds.has(task.id)).toBe(true);
    const log = store.logEntry.mock.calls.map((call: unknown[]) => call[1]).join("\n");
    expect(log).toContain("Pause abort classified:");
    expect(log).toContain("Workflow graph run ended after operator cancellation");
  });

  it("keeps engine-abort merge recovery eligible but excludes the same shape when user-canceled", async () => {
    const { executor, task } = makeHarness();

    await expect((executor as any).isRetryableBenignMergePauseAbort(
      task,
      mergePauseAbort,
      "engine-abort",
      true,
      false,
    )).resolves.toBe(true);
    await expect((executor as any).isRetryableBenignMergePauseAbort(
      task,
      mergePauseAbort,
      "engine-abort",
      true,
      true,
    )).resolves.toBe(false);
  });

  it.each([
    ["singular", { worktree: "/tmp/fn-249-singular", branch: "fusion/fn-249-singular", workspaceWorktrees: undefined }],
    ["workspace", {
      worktree: undefined,
      branch: undefined,
      workspaceWorktrees: {
        api: { worktreePath: "/tmp/fn-249-workspace/api", branch: "fusion/fn-249-workspace" },
        web: { worktreePath: "/tmp/fn-249-workspace/web", branch: "fusion/fn-249-workspace" },
      },
    }],
  ] as const)("stops the production graph before the real merge requester for a %s task", async (_shape, taskShape) => {
    const { executor, store, task } = makeHarness({
      ...taskShape,
      enabledWorkflowSteps: ["documentation-delivery"],
      workflowStepResults: [],
    });
    store.getTask.mockResolvedValue(task);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15_000,
      autoMerge: true,
      maxAutoMergeRetries: 3,
    });
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({ workflowId: "WF-fn-249-cancel", stepIds: [] }));
    store.getTaskWorkflowSelection = vi.fn(() => ({ workflowId: "WF-fn-249-cancel", stepIds: [] }));
    store.getWorkflowDefinition = vi.fn(async () => ({
      id: "WF-fn-249-cancel",
      name: "Operator cancellation",
      ir: cancellationWorkflow,
    }));
    store.updateTaskAtomic = vi.fn(async (taskId: string, updater: (current: TaskDetail) => Partial<TaskDetail> | null) => {
      const current = await store.getTask(taskId);
      const patch = updater(current);
      if (patch) await store.updateTask(taskId, patch);
      return store.getTask(taskId);
    });

    const mergeRequester = vi.fn(async () => ({ merged: false, noOp: false, reason: "unexpected-merge" }));
    executor.setMergeRequester(mergeRequester as never);
    const graphFailures: unknown[] = [];
    const originalHandleGraphFailure = (executor as any).handleGraphFailure.bind(executor);
    const handleGraphFailure = vi.spyOn(executor as any, "handleGraphFailure").mockImplementation(async (...args: unknown[]) => {
      graphFailures.push(args[1]);
      return originalHandleGraphFailure(...args);
    });
    let customNodeCalls = 0;
    const runGraphCustomNode = vi.spyOn(executor as any, "runGraphCustomNode").mockImplementation(async () => {
      customNodeCalls += 1;
      const controller = (executor as any).activeWorkflowGraphAbortControllers.get(task.id) as AbortController | undefined;
      expect(controller).toBeDefined();
      (executor as any).userCanceledTaskIds.add(task.id);
      controller!.abort();
      return { outcome: "success", value: "failed" };
    });

    try {
      await (executor as any).executeWorkflowGraph(task);
    } finally {
      runGraphCustomNode.mockRestore();
      handleGraphFailure.mockRestore();
    }

    expect(graphFailures[0]).toMatchObject({ interruptedNodeId: "documentation-step" });
    expect(customNodeCalls).toBe(1);
    expect(mergeRequester).not.toHaveBeenCalled();
    expect((await store.getTask(task.id)).workflowStepResults ?? []).toEqual([]);
    expect(store.updateTask).not.toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    const log = store.logEntry.mock.calls.map((call: unknown[]) => call[1]).join("\n");
    expect(log).toContain("Workflow graph run ended after operator cancellation");
    expect(log).not.toContain("routed to bounded auto-merge retry");
  });
});

/*
FNXC:WorkflowLifecycle 2026-08-31-03:32:
The FN-249 marker is task-scoped and in-memory, but its exit claims to be terminal only for "its
in-flight graph run". Its sole clear sites are the implementation loop and the move-INTO-WIP
listener, so a card canceled in the REVIEW lane kept the marker forever and every LATER run exited
quietly. Measured on FN-270/FN-273: a Code Review REVISE was swallowed 76ms after being recorded,
no remediation was produced, and the card could not reach WIP -- the very move that clears the
marker. Dashboard Retry hard-cancels to restart the step, so each Retry re-armed the trap.

These cases pin the INVARIANT, not the repro: a run with NO abort evidence must never be treated as
canceled (and must disarm the stale marker), while EVERY individual evidence shape must still take
the FN-249 terminal exit.
*/
describe("stale operator-cancellation marker never swallows a later run", () => {
  // A review REVISE failure: a real graph failure with no interruption and no abort kind.
  const reviewReviseFailure = {
    disposition: "failed",
    outcome: "failure",
    visitedNodeIds: ["code-review-step"],
    context: { "node:code-review-step:value": "revise" },
  } as const;

  function makeHarness(overrides: Partial<TaskDetail> = {}) {
    resetExecutorMocks();
    const store = createMockStore();
    const task = makeTask(overrides);
    store.getTask.mockResolvedValue(task);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15_000,
      autoMerge: true,
      maxAutoMergeRetries: 3,
    });
    const executor = new TaskExecutor(store as never, "/tmp/test");
    return { executor, store, task };
  }

  function logOf(store: ReturnType<typeof createMockStore>) {
    return store.logEntry.mock.calls.map((call: unknown[]) => call[1]).join("\n");
  }

  /*
  THE production sequence. A dashboard Retry on an IDLE in-review card runs pause -> hard-cancel ->
  unpause, and `awaitAbortInFlightTaskWork` stamps `markPausedAborted` unconditionally even though
  nothing was live to abort. The reset at run birth is the only thing that stops the next run from
  inheriting both leftovers.

  This asserts the reset ITSELF rather than a downstream branch, because the two leftovers strand the
  card through two different readers: the operator-cancellation exit AND `genuinePauseAbort`. An
  earlier fixture set only `userCanceledTaskIds` and passed while FN-273 stranded in production at
  06:19:48 -- reproducing the real precondition is the whole point.
  */
  it("clears both abort leftovers of a dashboard Retry when the next run is born", async () => {
    const { executor, task } = makeHarness();
    (executor as any).markPausedAborted(task.id, "hard-cancel");
    (executor as any).userCanceledTaskIds.add(task.id);
    expect((executor as any).pausedAborted.has(task.id)).toBe(true);

    await (executor as any).executeWorkflowGraph(task).catch(() => undefined);

    expect((executor as any).userCanceledTaskIds.has(task.id)).toBe(false);
    expect((executor as any).pausedAborted.has(task.id)).toBe(false);
    expect((executor as any).pausedAbortProvenance.has(task.id)).toBe(false);
  });

  /*
  With the reset in place a marker seen at teardown can only have been set during this run, so the
  FN-249 terminal exit is honored verbatim. Kept as a control: it must not start ignoring a real one.
  */
  it("still exits terminally for a cancellation marked during the run", async () => {
    const { executor, store, task } = makeHarness();
    const resume = vi.spyOn(executor as any, "routeGraphFailureToExecutionResume").mockResolvedValue(true);
    (executor as any).userCanceledTaskIds.add(task.id);

    await (executor as any).handleGraphFailure(task, mergePauseAbort);

    expect(logOf(store)).toContain("Workflow graph run ended after operator cancellation");
    expect(resume).not.toHaveBeenCalled();
  });

  it("leaves an uncanceled task completely untouched", async () => {
    const { executor, store, task } = makeHarness();
    const resume = vi.spyOn(executor as any, "routeGraphFailureToExecutionResume").mockResolvedValue(true);

    await (executor as any).handleGraphFailure(task, reviewReviseFailure);

    const log = logOf(store);
    expect(log).not.toContain("Workflow graph run ended after operator cancellation");
    expect(resume).toHaveBeenCalled();
  });
});

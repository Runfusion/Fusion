import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";
import { routeGraphMergeFailureToRetry } from "../../executor/route-graph-merge-failure-to-retry.js";
import type { TaskDetail } from "@fusion/core";

const now = "2026-08-26T00:00:00.000Z";

/**
 * FNXC:MergeRetryReliability 2026-08-26-11:30 (GDPR-053 field report):
 * Regression tests for the swallowed mergeRequester rejection in
 * routeGraphMergeFailureToRetry. Before the fix, a rejected retry request was
 * reduced to executorLog.warn: the task kept its lane/status with no error and
 * nothing ever retried the merge, so the card sat silently for hours.
 *
 * FNXC:MergeRetryReliability 2026-08-26-12:40 (review): parameterized across the
 * known merge-request rejection surfaces (getTaskMergeBlocker reasons).
 */

const REJECTION_SURFACES = [
  { label: "needs-replan", rejection: "Cannot merge FN-GDPR53-T: task is marked 'needs-replan'" },
  { label: "paused", rejection: "Cannot merge FN-GDPR53-T: task is paused" },
  { label: "planning", rejection: "Cannot merge FN-GDPR53-T: task is marked 'planning'" },
  { label: "stuck-killed", rejection: "Cannot merge FN-GDPR53-T: task is marked 'stuck-killed'" },
] as const;

function rejectBoundedParksThenRecover() {
  let attempts = 0;
  return vi.fn(async () => {
    attempts += 1;
    if (attempts <= 14) throw new Error("store down");
    return undefined;
  });
}

function makeTask(testWorktree: string, overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-GDPR53-T",
    title: "Swallowed merge retry repro",
    description: "mergeRequester rejection must park the task, not vanish",
    column: "in-review",
    dependencies: [],
    steps: [
      { name: "Implement", status: "done" },
      { name: "Verify", status: "done" },
    ],
    currentStep: 1,
    log: [],
    branch: "fusion/fn-gdpr53-t",
    baseBranch: "main",
    worktree: testWorktree,
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

async function runRejectedRetryScenario(rejectionMessage: string, opts: { failLogWrite?: boolean } = {}) {
  const testRepoRoot = await mkdtemp(join(tmpdir(), "fusion-gdpr53-root-"));
  const store = createMockStore();
  // FNXC:MergeRetryReliability 2026-08-29-14:20: CWE-377: unique temp dir per scenario instead of a predictable fixed path.
  const testWorktree = await mkdtemp(join(tmpdir(), "fusion-gdpr53-wt-"));
  const task = makeTask(testWorktree);
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: false,
    autoMerge: true,
    maxAutoMergeRetries: 3,
    worktreeInitCommand: undefined,
  });
  if (opts.failLogWrite) {
    store.logEntry.mockImplementation(async (_id: string, action: string) => {
      if (action.startsWith("Bounded auto-merge retry request rejected")) {
        throw new Error("log write failed");
      }
      return undefined;
    });
  }
  (store as any).updateTaskAtomic = vi.fn(async (id: string, reducer: (current: TaskDetail) => Partial<TaskDetail> | null, context: unknown) => {
    const patch = reducer(task);
    return patch ? store.updateTask(id, patch, context) : task;
  });
  const executor = new TaskExecutor(store, testRepoRoot, {});
  // FNXC:MergeRetryReliability 2026-08-29-14:20: The field failure: onMerge rejects because getTaskMergeBlocker sees a
  // FNXC:MergeRetryReliability 2026-08-29-14:20: blocking status that appeared after the graph run started.
  const mergeRequester = vi.fn(async () => {
    throw new Error(rejectionMessage);
  });
  executor.setMergeRequester(mergeRequester as any);
  (executor as any).markPausedAborted(task.id, "pause-resume");

  await (executor as any).handleGraphFailure(task, {
    disposition: "failed",
    outcome: "failure",
    visitedNodeIds: ["review", "merge"],
    context: {},
  });

  return { store, mergeRequester };
}

describe("routeGraphMergeFailureToRetry — rejected merge requester", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it.for(REJECTION_SURFACES)("parks the task failed with the reason ($label)", async ({ rejection }) => {
    const { store, mergeRequester } = await runRejectedRetryScenario(rejection);

    expect(mergeRequester).toHaveBeenCalledTimes(1);

    const failedUpdate = store.updateTask.mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
    const error = (failedUpdate![1] as Record<string, unknown>).error as string;
    expect(error).toContain("AUTO_MERGE_RETRY_REJECTED");
    expect(error).toContain(rejection);

    const logText = store.logEntry.mock.calls.map((call: unknown[]) => call[1]).join("\n");
    expect(logText).toContain("parking task for human intervention");
    expect(logText).toContain(rejection);
  });

  it.for(REJECTION_SURFACES)("parks even when the rejection log write fails ($label)", async ({ rejection }) => {
    const { store } = await runRejectedRetryScenario(rejection, { failLogWrite: true });

    const failedUpdate = store.updateTask.mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
    expect(String((failedUpdate![1] as Record<string, unknown>).error)).toContain(rejection);
  });

  it("treats a rejection with an undefined cause as a real rejection (Promise.reject())", async () => {
    const store = createMockStore();
    const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-wt-")));
    store.getTask.mockResolvedValue(task);
    store.getSettings.mockResolvedValue({ autoMerge: true });
    const mergeRequester = vi.fn(async () => {
      return Promise.reject(undefined);
    });
    (store as any).updateTaskAtomic = vi.fn(async (_id: string, reducer: (current: TaskDetail) => Partial<TaskDetail> | null, context: unknown) => {
      const patch = reducer(task);
      return patch ? store.updateTask(task.id, patch, context) : task;
    });
    const executor = new TaskExecutor(store, await mkdtemp(join(tmpdir(), "fusion-gdpr53-root-")), {});
    executor.setMergeRequester(mergeRequester as any);
    (executor as any).markPausedAborted(task.id, "pause-resume");

    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["review", "merge"],
      context: {},
    });

    expect(mergeRequester).toHaveBeenCalledTimes(1);

    const failedUpdate = store.updateTask.mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
    // FNXC:MergeRetryReliability 2026-08-29-14:20: rejection with an undefined cause must still park: reason is String(undefined)
    expect(String((failedUpdate![1] as Record<string, unknown>).error)).toContain("AUTO_MERGE_RETRY_REJECTED");
    expect(String((failedUpdate![1] as Record<string, unknown>).error)).toContain("undefined");

    const logText = store.logEntry.mock.calls.map((call: unknown[]) => call[1]).join("\n");
    expect(logText).toContain("parking task for human intervention");
    expect(logText).toContain("undefined");
  });

  it(
    "returns not-handled (no terminal misclassification) when every park write exhausts the retries",
    async () => {
      vi.useFakeTimers();
      try {
      const scenario = "Cannot merge FN-GDPR53-T: task is marked 'needs-replan'";
      const store = createMockStore();
      const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-wt-")));
      store.getTask.mockResolvedValue(task);
      store.getSettings.mockResolvedValue({ autoMerge: true });
      const executor = new TaskExecutor(store, await mkdtemp(join(tmpdir(), "fusion-gdpr53-root-")), {});
      // FNXC:MergeRetryReliability 2026-08-29-14:20: store is down: every park write rejects
      store.updateTask.mockImplementation(async () => {
        throw new Error("store down");
      });
      (store as any).updateTaskAtomic = vi.fn(async () => {
        throw new Error("store down");
      });
      const mergeRequester = vi.fn(async () => {
        throw new Error(scenario);
      });
      executor.setMergeRequester(mergeRequester as any);
      (executor as any).markPausedAborted(task.id, "pause-resume");

      let threw = false;
      try {
        const handling = (executor as any).handleGraphFailure(task, {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: ["review", "merge"],
          context: {},
        });
        await vi.advanceTimersByTimeAsync(70_000);
        await handling;
      } catch {
        threw = true;
      }

      // FNXC:MergeRetryReliability 2026-08-29-14:20: the retry route must not throw into the log-only catch — exhaustion returns
      // FNXC:MergeRetryReliability 2026-08-29-14:20: false so the graph-failure handler's own terminal routing takes over
      expect(threw).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("parks through the atomic retry fence when the merge request is rejected", async () => {
    const scenario = "Cannot merge FN-GDPR53-T: task is marked 'needs-replan'";
    const store = createMockStore();
    const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-wt-")));
    store.getTask.mockResolvedValue(task);
    store.getSettings.mockResolvedValue({ autoMerge: true });
    const executor = new TaskExecutor(store, await mkdtemp(join(tmpdir(), "fusion-gdpr53-root-")), {});
    const atomicWrite = vi.fn(async (_id: string, reducer: (current: TaskDetail) => Partial<TaskDetail> | null, context: unknown) => {
      const patch = reducer(task);
      return patch ? store.updateTask(task.id, patch, context) : task;
    });
    (store as any).updateTaskAtomic = atomicWrite;
    executor.setMergeRequester(vi.fn(async () => {
      throw new Error(scenario);
    }) as any);
    (executor as any).markPausedAborted(task.id, "pause-resume");

    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["review", "merge"],
      context: {},
    });

    const failedUpdate = store.updateTask.mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
    expect(String((failedUpdate![1] as Record<string, unknown>).error)).toContain("AUTO_MERGE_RETRY_REJECTED");
    expect(atomicWrite).toHaveBeenCalledTimes(1);
  });

  it("settles a rejected retry when an operator requeues during store recovery", async () => {
    vi.useFakeTimers();
    try {
      const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-wt-")), {
        columnMovedAt: "2026-09-04T02:43:00.000Z",
      });
      const requeued = { ...task, columnMovedAt: "2026-09-04T02:44:00.000Z" };
      let current = task;
      const store = createMockStore();
      const updateTaskAtomic = vi.fn(async (_id: string, reducer: (row: TaskDetail) => Partial<TaskDetail> | null) => {
        if (updateTaskAtomic.mock.calls.length === 1) throw new Error("store unavailable");
        const patch = reducer(current);
        if (patch) current = { ...current, ...patch };
        return current;
      });
      (store as any).updateTaskAtomic = updateTaskAtomic;
      const outcome = routeGraphMergeFailureToRetry({
        store,
        getRunContextFor: () => undefined,
        mergeRequester: vi.fn(async () => { throw new Error("request rejected"); }),
        ensureWorkflowMergeBoundaryTask: vi.fn(async () => ({ task })),
        persistTokenUsage: vi.fn(),
      }, task, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["review", "merge"],
        context: {},
      } as any, "merge-seam" as any);

      await vi.advanceTimersByTimeAsync(0);
      current = requeued;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await outcome).toBe(true);
      expect(updateTaskAtomic).toHaveBeenCalledTimes(2);
      expect(current).toEqual(requeued);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the terminal error non-empty so operators see why the retry gave up", async () => {
    const { store } = await runRejectedRetryScenario(REJECTION_SURFACES[0].rejection);

    const failedUpdate = store.updateTask.mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
    expect(String((failedUpdate![1] as Record<string, unknown>).error)).not.toHaveLength(0);
  });

  /*
  FNXC:MergeRetryReliability 2026-08-29-06:54:
  Greptile P1 (finding 7): when every park write exhausts the bounded backoff, the
  route MUST return false (not throw, not true) so the graph-failure
  handler's method-level catch can take over with its own durable terminal park.
  Direct unit test on routeGraphMergeFailureToRetry so the boolean is observed
  independent of handleGraphFailure's wrapping.
  */
  it(
    "returns false (not true, not throw) when every park write exhausts the bounded backoff",
    async () => {
      vi.useFakeTimers();
      try {
      const store = createMockStore();
      const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-wt-")));
      // FNXC:MergeRetryReliability 2026-08-29-14:20: every park write rejects — exhausts the 7-attempt backoff
      store.updateTask.mockImplementation(async () => {
        throw new Error("store down");
      });
      (store as any).updateTaskAtomic = vi.fn(async () => {
        throw new Error("store down");
      });
      const mergeRequester = vi.fn(async () => {
        throw new Error("Cannot merge FN-GDPR53-T: task is marked 'needs-replan'");
      });
      const ensureWorkflowMergeBoundaryTask = vi.fn(async () => ({
        task,
        blocked: undefined,
      }));
      const result = routeGraphMergeFailureToRetry(
        {
          store,
          getRunContextFor: () => undefined,
          mergeRequester,
          ensureWorkflowMergeBoundaryTask,
          persistTokenUsage: vi.fn(),
        },
        task,
        {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: ["review", "merge"],
          context: {},
        } as any,
        "merge-seam" as any,
      );
      await vi.advanceTimersByTimeAsync(70_000);
      expect(await result).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  /*
  FNXC:MergeRetryReliability 2026-08-29-06:54:
  Greptile P1 (finding 19): when the failed run's execution context is absent at
  exhaustion time, capturedRunId is undefined and the deferred terminal park MUST
  be skipped entirely — no scheduled chain, no updateTaskAtomic call. A
  null-status lane row is parked at restart by resumeOrphaned() instead.
  Uses fake timers to fast-forward through the 7-attempt backoff (~63s of
  real time) in milliseconds, then asserts no atomic write was scheduled.
  */
  it(
    "skips the deferred terminal park when no execution context exists at exhaustion (no updateTaskAtomic call)",
    async () => {
      vi.useFakeTimers();
      try {
        const scenario = "Cannot merge FN-GDPR53-T: task is marked 'needs-replan'";
        const store = createMockStore();
        const dir = await mkdtemp(join(tmpdir(), "fusion-gdpr53-wt-"));
        const task = makeTask(dir);
        store.getTask.mockResolvedValue(task);
        store.getSettings.mockResolvedValue({ autoMerge: true });
        store.updateTask.mockImplementation(async () => {
          throw new Error("store down");
        });
        // FNXC:MergeRetryReliability 2026-09-04-02:43: Exhaust both bounded persistence paths before evaluating no-context scheduling.
        (store as any).updateTaskAtomic = rejectBoundedParksThenRecover();
        const executor = new TaskExecutor(store, await mkdtemp(join(tmpdir(), "fusion-gdpr53-root-")), {});
        executor.setMergeRequester(vi.fn(async () => {
          throw new Error(scenario);
        }) as any);
        (executor as any).markPausedAborted(task.id, "pause-resume");

        // FNXC:MergeRetryReliability 2026-08-29-14:20: Drive handleGraphFailure and fast-forward through the park backoff
        // FNXC:MergeRetryReliability 2026-08-29-14:20: (1+2+4+8+16+32 = ~63s) plus the deferred setTimeout.
        const promise = (executor as any).handleGraphFailure(task, {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: ["review", "merge"],
          context: {},
        });
        // FNXC:MergeRetryReliability 2026-08-29-14:20: Advance through all backoff delays: 1+2+4+8+16+32 = ~63s,
        // FNXC:MergeRetryReliability 2026-08-29-14:20: plus the deferred setTimeout(0) and any retry round.
        await vi.advanceTimersByTimeAsync(70_000);
        await promise;

        // FNXC:MergeRetryReliability 2026-09-04-02:43: No context skips the deferred callback after bounded persistence exhausts.
        const atomicCalls = (store.updateTaskAtomic as unknown as { mock: { calls: unknown[] } }).mock.calls;
        expect(atomicCalls.length).toBe(7);
      } finally {
        vi.useRealTimers();
      }
    },
    30_000,
  );

  /*
  FNXC:MergeRetryReliability 2026-08-29-06:54:
  Greptile P1 (finding 16): when a task starts a newer execution while the
  terminal persistence waits for the store to recover, the deferred callback
  MUST honor runId fencing (currentRunId !== capturedRunId → skip the write).
  Uses fake timers to fast-forward through the 7-attempt backoff.
  */
  it(
    "parks the deferred write even when the run context was cleared before the callback fires",
    async () => {
      vi.useFakeTimers();
      try {
        const scenario = "Workflow graph run failed at node 'review'";
        const store = createMockStore();
        const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-wt-")), {
          column: "in-progress",
          columnMovedAt: "2026-09-04T01:00:00.000Z",
        });
        store.getTask.mockResolvedValue(task);
        store.getSettings.mockResolvedValue({ autoMerge: true });
        store.updateTask.mockImplementation(async () => {
          throw new Error("store down");
        });
        // FNXC:MergeRetryReliability 2026-09-04-02:43: The deferred callback sees recovery only after both bounded paths exhaust.
        (store as any).updateTaskAtomic = rejectBoundedParksThenRecover();
        const executor = new TaskExecutor(store, await mkdtemp(join(tmpdir(), "fusion-gdpr53-root-")), {});
        /*
        FNXC:MergeRetryReliability 2026-08-29-12:05 (Greptile round-4 Issue 1):
        the context is captured (with runId A) at exhaustion, then CLEARED by
        normal execution teardown before the deferred callback fires. The
        counting spy stands in for the real currentRunContexts lifecycle: the
        route/exhaustion reads (1-3) still see run A; the deferred callback's
        fence read sees no context at all. No OTHER run owns the task, so the
        park must still proceed — otherwise the lane-resident null-status row
        waits for an engine restart.
        */
        vi.spyOn(executor as any, "getRunContextFor").mockImplementation(() => {
          // Stack-based fence simulation: reads made INSIDE the deferred
          // callback (scheduleDeferredTerminalPark's setTimeout) run after
          // normal teardown cleared the context; every read before that
          // (inside handleGraphFailure/route) still sees the captured run.
          // Deterministic regardless of how many routing reads precede the
          // deferred chain.
          // FNXC:MergeRetryReliability 2026-08-29-17:40 (CodeRabbit L399): drive
          // the fence from OBSERVED state, not stack traces: the executor marks
          // the task in deferredTerminalParksInFlight while the deferred
          // callback runs, so the spy flips on observed execution, immune to
          // renaming, inlining, or the V8 stackTraceLimit.
          const inDeferredCallback = (executor as any).deferredTerminalParksInFlight.has(task.id);
          return inDeferredCallback ? undefined : { runId: "captured-run-A", agentId: "executor" };
        });
        const promise = (executor as any).handleGraphFailure(task, {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: ["execute", "review"],
          context: {},
        });
        await vi.advanceTimersByTimeAsync(70_000);
        await promise;

        const atomicCalls = (store.updateTaskAtomic as unknown as { mock: { calls: unknown[] } }).mock.calls;
        expect(atomicCalls.length).toBe(15);
        const reducer = atomicCalls[14][1] as (current: TaskDetail) => unknown;
        expect(reducer({ ...task, columnMovedAt: "2026-09-04T01:01:00.000Z" })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
    30_000,
  );

  /*
  FNXC:MergeRetryReliability 2026-08-29-12:05 (Greptile round-4 Issue 1): the
  runId fence still protects against a DIFFERENT ACTIVE run — only the
  cleared-context case may proceed. A newer execution that re-registered its
  own run context must not be parked by the stale deferred callback.
  */
  it(
    "skips the deferred write when a different run is now active",
    async () => {
      vi.useFakeTimers();
      try {
        const scenario = "Cannot merge FN-GDPR53-T: task is marked 'needs-replan'";
        const store = createMockStore();
        const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-wt-")));
        store.getTask.mockResolvedValue(task);
        store.getSettings.mockResolvedValue({ autoMerge: true });
        store.updateTask.mockImplementation(async () => {
          throw new Error("store down");
        });
        (store as any).updateTaskAtomic = rejectBoundedParksThenRecover();
        const executor = new TaskExecutor(store, await mkdtemp(join(tmpdir(), "fusion-gdpr53-root-")), {});
        /*
        FNXC:MergeRetryReliability 2026-08-29-12:05 (Greptile round-4 Issue 1):
        counter-case to the cleared-context test: the capture at exhaustion
        still saw run A, but by callback time a NEWER execution re-registered
        its own context (run B). The fence must skip the write — the stale
        handler must not park freshly recovered or requeued work.
        */
        vi.spyOn(executor as any, "getRunContextFor").mockImplementation(() => {
          // FNXC:MergeRetryReliability 2026-08-29-17:40 (CodeRabbit L399): key
          // on the executor's in-flight marker (observed state), not stack.
          const inDeferredCallback = (executor as any).deferredTerminalParksInFlight.has(task.id);
          return inDeferredCallback
            ? { runId: "newer-run-B", agentId: "executor" }
            : { runId: "captured-run-A", agentId: "executor" };
        });
        executor.setMergeRequester(vi.fn(async () => {
          throw new Error(scenario);
        }) as any);

        const promise = (executor as any).handleGraphFailure(task, {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: ["review", "merge"],
          context: {},
        });
        await vi.advanceTimersByTimeAsync(70_000);
        await promise;

        const atomicCalls = (store.updateTaskAtomic as unknown as { mock: { calls: unknown[] } }).mock.calls;
        expect(atomicCalls.length).toBe(7);
      } finally {
        vi.useRealTimers();
      }
    },
    30_000,
  );

  /*
  FNXC:MergeRetryReliability 2026-08-29-12:20 (Greptile round-8 Issue 1):
  counter-case to the cleared-context write: a valid requeue ALSO clears the
  run context, but the task is live on an execution surface (executing set).
  The stale deferred callback must NOT terminalize that newer work — even
  with currentRunId === undefined — or a requeued task is marked failed with
  the previous run's graph-failure message.
  */
  it(
    "skips the deferred write when the run context is cleared but the task is live on an execution surface",
    async () => {
      vi.useFakeTimers();
      try {
        const scenario = "Workflow graph run failed at node 'review'";
        const store = createMockStore();
        const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-wt-")), { column: "in-progress" });
        store.getTask.mockResolvedValue(task);
        store.getSettings.mockResolvedValue({ autoMerge: true });
        store.updateTask.mockImplementation(async () => {
          throw new Error("store down");
        });
        (store as any).updateTaskAtomic = rejectBoundedParksThenRecover();
        const executor = new TaskExecutor(store, await mkdtemp(join(tmpdir(), "fusion-gdpr53-root-")), {});
        // FNXC:MergeRetryReliability 2026-08-29-16:52 (CodeRabbit L395): key on
        // the named deferred callback instead of a line/call count.
        vi.spyOn(executor as any, "getRunContextFor").mockImplementation(() => {
          const inDeferredCallback = (executor as any).deferredTerminalParksInFlight.has(task.id);
          return inDeferredCallback
            ? undefined
            : { runId: "captured-run-A", agentId: "executor" };
        });
        // FNXC:MergeRetryReliability 2026-08-29-14:20: Requeued task is LIVE on an execution surface even though its run
        // FNXC:MergeRetryReliability 2026-08-29-14:20: context was cleared — the stale callback must not park it.
        (executor as any).executing.add(task.id);
        const promise = (executor as any).handleGraphFailure(task, {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: ["execute", "review"],
          context: {},
        });
        await vi.advanceTimersByTimeAsync(70_000);
        await promise;

        const atomicCalls = (store.updateTaskAtomic as unknown as { mock: { calls: unknown[] } }).mock.calls;
        // FNXC:MergeRetryReliability 2026-09-04-02:43: The bounded retry exhausts; the live surface prevents deferred writes.
        expect(atomicCalls.length).toBe(7);
      } finally {
        vi.useRealTimers();
      }
    },
    30_000,
  );

  /*
  FNXC:MergeRetryReliability 2026-08-29-14:35 (Greptile round-9 Issue 1): the
  deferred chain is in-memory and dies with the engine — an exit during the
  store outage discards the pending failed-state write and restart recovery
  would RE-RUN the task. handleGraphFailure now persists a terminal-park
  intent next to the task dir; restart recovery must APPLY it (park failed
  with the original message) instead of re-executing, then remove it.
  */
  it(
    "restart recovery parks the task from a persisted deferred-park intent instead of re-executing",
    async () => {
      const testTasksDir = await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-"));
      const taskDir = join(testTasksDir, "FN-GDPR53-T");
      await mkdir(taskDir, { recursive: true });
      const scenario = "Workflow graph run failed at node 'review'";
      await writeFile(
        join(taskDir, "deferred-terminal-park.json"),
        JSON.stringify({ message: scenario }),
        "utf-8",
      );
      const store = createMockStore();
      // FNXC:MergeRetryReliability 2026-08-29-17:45 (CodeRabbit L100): seed the
      // row with status UNDEFINED (not null) — a lane-resident row can carry it
      // after requeue, and nullish (not ===) comparison must still park it.
      const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-wt-")), { column: "in-progress", status: undefined });
      store.getSettings.mockResolvedValue({ autoMerge: true });
      store.updateTaskAtomic = vi.fn(async (_id: string, reducer: (current: any) => unknown) => {
        return reducer({ ...task });
      }) as any;
      const executor = new TaskExecutor(store as any, await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-root-")), {});
      vi.spyOn(executor as any, "listWipLaneTasks").mockResolvedValue([task]);
      const executeSpy = vi.spyOn(executor as any, "execute");
      (store as any).getTasksDir = vi.fn().mockReturnValue(testTasksDir);

      await (executor as any).resumeOrphaned();

      // The intent was applied: failed status with the ORIGINAL message…
      const [atomicId, atomicReducer] = (store.updateTaskAtomic as unknown as { mock: { calls: unknown[] } }).mock.calls[0] as [string, (current: any) => unknown];
      expect(atomicId).toBe("FN-GDPR53-T");
      expect(atomicReducer({ ...task })).toEqual({ error: scenario, status: "failed" });
      // …and the task was NOT re-executed.
      expect(executeSpy).not.toHaveBeenCalled();
      // The intent file is gone (fulfilled).
      await expect(readFile(join(taskDir, "deferred-terminal-park.json"), "utf-8")).rejects.toThrow();
    },
    30_000,
  );

  /*
  FNXC:MergeRetryReliability 2026-08-29-18:10 (Greptile P1): a crash mid-write
  leaves deferred-terminal-park.json truncated or invalid. The reader must
  NOT treat a parse failure as a missing intent — re-executing re-runs a
  graph the engine already decided was terminal. Park with a conservative
  message instead.
  */
  it(
    "restart recovery parks from a corrupted intent instead of re-executing",
    async () => {
      const testTasksDir = await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-"));
      const taskDir = join(testTasksDir, "FN-GDPR53-T");
      await mkdir(taskDir, { recursive: true });
      // Truncated mid-write: invalid JSON that never decodes.
      await writeFile(
        join(taskDir, "deferred-terminal-park.json"),
        "{\"message\": \"Workflow graph run failed at node 'rev",
        "utf-8",
      );
      const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-wt-")), { column: "in-progress" });
      const store = createMockStore();
      store.getSettings.mockResolvedValue({ autoMerge: true });
      store.updateTaskAtomic = vi.fn(async (_id: string, reducer: (current: any) => unknown) => {
        return reducer({ ...task });
      }) as any;
      const executor = new TaskExecutor(store as any, await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-root-")), {});
      vi.spyOn(executor as any, "listWipLaneTasks").mockResolvedValue([task]);
      const executeSpy = vi.spyOn(executor as any, "execute");
      (store as any).getTasksDir = vi.fn().mockReturnValue(testTasksDir);

      await (executor as any).resumeOrphaned();

      // Parked failed (never re-executed), with the conservative message.
      const [atomicId, atomicReducer] = (store.updateTaskAtomic as unknown as { mock: { calls: unknown[] } }).mock.calls[0] as [string, (current: any) => unknown];
      expect(atomicId).toBe("FN-GDPR53-T");
      expect(atomicReducer({ ...task })).toEqual({ error: "deferred-terminal-park intent was corrupted by a crash mid-write — parked instead of re-executing", status: "failed" });
      expect(executeSpy).not.toHaveBeenCalled();
      await expect(readFile(join(taskDir, "deferred-terminal-park.json"), "utf-8")).rejects.toThrow();
    },
    30_000,
  );

  /*
  FNXC:MergeRetryReliability 2026-08-29-18:10 (CodeRabbit 17:59): an intent
  older than the freshness horizon describes a failure that predates an
  operator requeue (task left the WIP lane and returned). The reader clears
  it and proceeds with normal orphan recovery instead of parking the task
  with a dead run's message.
  */
  it(
    "restart recovery clears a stale intent instead of parking with a dead run's message",
    async () => {
      const testTasksDir = await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-"));
      const taskDir = join(testTasksDir, "FN-GDPR53-T");
      await mkdir(taskDir, { recursive: true });
      const staleWrittenAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await writeFile(
        join(taskDir, "deferred-terminal-park.json"),
        JSON.stringify({ message: "Workflow graph run failed at node 'review'", writtenAt: staleWrittenAt }),
        "utf-8",
      );
      const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-wt-")), { column: "in-progress" });
      const store = createMockStore();
      store.getSettings.mockResolvedValue({ autoMerge: true });
      store.updateTaskAtomic = vi.fn(async (_id: string, reducer: (current: any) => unknown) => {
        return reducer({ ...task });
      }) as any;
      const executor = new TaskExecutor(store as any, await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-root-")), {});
      vi.spyOn(executor as any, "listWipLaneTasks").mockResolvedValue([task]);
      const executeSpy = vi.spyOn(executor as any, "execute");
      (store as any).getTasksDir = vi.fn().mockReturnValue(testTasksDir);

      await (executor as any).resumeOrphaned();

      // Stale intent cleared, NOT applied as a park.
      expect((store.updateTaskAtomic as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
      await expect(readFile(join(taskDir, "deferred-terminal-park.json"), "utf-8")).rejects.toThrow();
    },
    30_000,
  );


  it("parks the first boundary-preparation rejection after bounded retries", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockStore();
      const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-boundary-wt-")));
      (store as any).updateTaskAtomic = vi.fn(async (_id: string, reducer: (current: TaskDetail) => Partial<TaskDetail> | null, context: unknown) => {
        const patch = reducer(task);
        return patch ? store.updateTask(task.id, patch, context) : task;
      });
      const ensureWorkflowMergeBoundaryTask = vi.fn(async () => {
        if (ensureWorkflowMergeBoundaryTask.mock.calls.length === 1) throw new Error("first-cause");
        throw new Error("later-cause");
      });
      const outcome = routeGraphMergeFailureToRetry({
        store,
        getRunContextFor: () => undefined,
        mergeRequester: vi.fn(),
        ensureWorkflowMergeBoundaryTask,
        persistTokenUsage: vi.fn(),
      }, task, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["merge"],
        context: {},
      } as any, "merge-seam");

      await vi.advanceTimersByTimeAsync(70_000);
      expect(await outcome).toBe(true);
      const failedUpdate = store.updateTask.mock.calls.find(
        (call: unknown[]) => (call[1] as Record<string, unknown>)?.status === "failed",
      );
      expect(String((failedUpdate?.[1] as Record<string, unknown>)?.error)).toContain("first-cause");
      expect(String((failedUpdate?.[1] as Record<string, unknown>)?.error)).not.toContain("later-cause");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not park a replacement execution when boundary preparation returns blocked", async () => {
    const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-boundary-requeue-wt-")), {
      columnMovedAt: "2026-09-04T03:01:00.000Z",
    });
    const replacement = {
      ...task,
      columnMovedAt: "2026-09-04T03:02:00.000Z",
      status: null,
      error: null,
    };
    let current = task;
    let resolveBoundary: ((value: { task: TaskDetail; blocked: { reason: string; code: "no-node-result"; missingInstanceCount: number } }) => void) | undefined;
    const boundaryPrepared = new Promise<{ task: TaskDetail; blocked: { reason: string; code: "no-node-result"; missingInstanceCount: number } }>((resolve) => {
      resolveBoundary = resolve;
    });
    const store = createMockStore();
    const updateTaskAtomic = vi.fn(async (_id: string, reducer: (row: TaskDetail) => Partial<TaskDetail> | null) => {
      const patch = reducer(current);
      if (patch) current = { ...current, ...patch };
      return current;
    });
    (store as any).updateTaskAtomic = updateTaskAtomic;
    const route = routeGraphMergeFailureToRetry({
      store,
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn(),
      ensureWorkflowMergeBoundaryTask: vi.fn(async () => boundaryPrepared),
      persistTokenUsage: vi.fn(),
    }, task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["merge"],
      context: {},
    } as any, "merge-seam");

    current = replacement;
    resolveBoundary?.({
      task,
      blocked: { reason: "no pre-merge node result", code: "no-node-result", missingInstanceCount: 0 },
    });

    expect(await route).toBe(true);
    expect(updateTaskAtomic).toHaveBeenCalledTimes(1);
    expect(current).toEqual(replacement);
    expect(store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.status === "failed",
    )).toBe(false);
  });

  it("clears a fresh intent superseded by an operator requeue", async () => {
    const testTasksDir = await mkdtemp(join(tmpdir(), "fusion-gdpr53-superseded-"));
    const taskDir = join(testTasksDir, "FN-GDPR53-T");
    await mkdir(taskDir, { recursive: true });
    const intentPath = join(taskDir, "deferred-terminal-park.json");
    await writeFile(intentPath, JSON.stringify({
      message: "old terminal failure",
      writtenAt: new Date().toISOString(),
      columnMovedAt: "2026-09-04T01:00:00.000Z",
    }), "utf-8");
    const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-wt-")), {
      column: "in-progress",
      columnMovedAt: "2026-09-04T01:01:00.000Z",
      steps: [{ name: "Implement", status: "pending" }],
      currentStep: 0,
    });
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ autoMerge: true });
    (store as any).updateTaskAtomic = vi.fn();
    (store as any).getTasksDir = vi.fn().mockReturnValue(testTasksDir);
    const executor = new TaskExecutor(store as any, await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-root-")), {});
    vi.spyOn(executor as any, "listWipLaneTasks").mockResolvedValue([task]);
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await (executor as any).resumeOrphaned();
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledWith(task);
    await expect(readFile(intentPath, "utf-8")).rejects.toThrow();
  });

  it("applies a fresh intent when its durable move identity matches", async () => {
    const testTasksDir = await mkdtemp(join(tmpdir(), "fusion-gdpr53-matching-"));
    const taskDir = join(testTasksDir, "FN-GDPR53-T");
    await mkdir(taskDir, { recursive: true });
    const columnMovedAt = "2026-09-04T01:00:00.000Z";
    await writeFile(join(taskDir, "deferred-terminal-park.json"), JSON.stringify({
      message: "terminal failure",
      writtenAt: new Date().toISOString(),
      columnMovedAt,
    }), "utf-8");
    const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-wt-")), { column: "in-progress", columnMovedAt });
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ autoMerge: true });
    (store as any).updateTaskAtomic = vi.fn(async (_id: string, reducer: (current: any) => unknown) => reducer({ ...task }));
    (store as any).getTasksDir = vi.fn().mockReturnValue(testTasksDir);
    const executor = new TaskExecutor(store as any, await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-root-")), {});
    vi.spyOn(executor as any, "listWipLaneTasks").mockResolvedValue([task]);
    const executeSpy = vi.spyOn(executor as any, "execute");

    await (executor as any).resumeOrphaned();

    expect((store.updateTaskAtomic as any).mock.calls[0][1]({ ...task })).toEqual({ error: "terminal failure", status: "failed" });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("does not park a requeue that races restart intent application", async () => {
    const testTasksDir = await mkdtemp(join(tmpdir(), "fusion-gdpr53-requeue-race-"));
    const taskDir = join(testTasksDir, "FN-GDPR53-T");
    await mkdir(taskDir, { recursive: true });
    const intentPath = join(taskDir, "deferred-terminal-park.json");
    const columnMovedAt = "2026-09-04T01:00:00.000Z";
    await writeFile(intentPath, JSON.stringify({
      message: "old terminal failure",
      writtenAt: new Date().toISOString(),
      columnMovedAt,
    }), "utf-8");
    const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-wt-")), {
      column: "in-progress",
      columnMovedAt,
      steps: [{ name: "Implement", status: "pending" }],
      currentStep: 0,
    });
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ autoMerge: true });
    (store as any).updateTaskAtomic = vi.fn(async (_id: string, reducer: (current: any) => unknown) => reducer({
      ...task,
      columnMovedAt: "2026-09-04T01:01:00.000Z",
    }));
    (store as any).getTasksDir = vi.fn().mockReturnValue(testTasksDir);
    const executor = new TaskExecutor(store as any, await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-root-")), {});
    vi.spyOn(executor as any, "listWipLaneTasks").mockResolvedValue([task]);
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await (executor as any).resumeOrphaned();
    await new Promise((resolve) => setImmediate(resolve));

    const reducer = (store.updateTaskAtomic as any).mock.calls[0][1];
    expect(reducer({ ...task, columnMovedAt: "2026-09-04T01:01:00.000Z" })).toBeNull();
    expect(executeSpy).toHaveBeenCalledWith(task);
    await expect(readFile(intentPath, "utf-8")).rejects.toThrow();
  });

  it("parks an empty intent as corruption instead of using an undefined message", async () => {
    const testTasksDir = await mkdtemp(join(tmpdir(), "fusion-gdpr53-empty-"));
    const taskDir = join(testTasksDir, "FN-GDPR53-T");
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "deferred-terminal-park.json"), "", "utf-8");
    const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-wt-")), { column: "in-progress" });
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ autoMerge: true });
    (store as any).updateTaskAtomic = vi.fn(async (_id: string, reducer: (current: any) => unknown) => reducer({ ...task }));
    (store as any).getTasksDir = vi.fn().mockReturnValue(testTasksDir);
    const executor = new TaskExecutor(store as any, await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-root-")), {});
    vi.spyOn(executor as any, "listWipLaneTasks").mockResolvedValue([task]);
    const executeSpy = vi.spyOn(executor as any, "execute");

    await (executor as any).resumeOrphaned();

    const reducer = (store.updateTaskAtomic as any).mock.calls[0][1];
    expect(reducer({ ...task })).toEqual({
      error: "deferred-terminal-park intent was corrupted by a crash mid-write — parked instead of re-executing",
      status: "failed",
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("retains an unreadable intent without parking or re-executing", async () => {
    const testTasksDir = await mkdtemp(join(tmpdir(), "fusion-gdpr53-unreadable-"));
    const taskDir = join(testTasksDir, "FN-GDPR53-T");
    const intentPath = join(taskDir, "deferred-terminal-park.json");
    await mkdir(intentPath, { recursive: true });
    const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-wt-")), { column: "in-progress" });
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ autoMerge: true });
    (store as any).updateTaskAtomic = vi.fn();
    (store as any).getTasksDir = vi.fn().mockReturnValue(testTasksDir);
    const executor = new TaskExecutor(store as any, await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-root-")), {});
    vi.spyOn(executor as any, "listWipLaneTasks").mockResolvedValue([task]);
    const executeSpy = vi.spyOn(executor as any, "execute");

    await (executor as any).resumeOrphaned();

    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
    await expect(readFile(intentPath, "utf-8")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("treats an absent intent as normal orphan recovery", async () => {
    const testTasksDir = await mkdtemp(join(tmpdir(), "fusion-gdpr53-absent-"));
    const task = makeTask(await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-wt-")), {
      column: "in-progress",
      steps: [{ name: "Implement", status: "pending" }],
      currentStep: 0,
    });
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ autoMerge: true });
    (store as any).updateTaskAtomic = vi.fn();
    (store as any).getTasksDir = vi.fn().mockReturnValue(testTasksDir);
    const executor = new TaskExecutor(store as any, await mkdtemp(join(tmpdir(), "fusion-gdpr53-intent-root-")), {});
    vi.spyOn(executor as any, "listWipLaneTasks").mockResolvedValue([task]);
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await (executor as any).resumeOrphaned();
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledWith(task);
  });
});

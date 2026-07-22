import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import type { TaskDetail } from "@fusion/core";

const now = "2026-06-20T00:00:00.000Z";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-6782-T",
    title: "pause-abort benign todo repro",
    description: "Reproduces FN-6782 benign requeue-to-todo classification",
    column: "todo",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: null,
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-6782-t",
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

type AbortProvenance = "hard-cancel" | "global-pause" | "merge-seam" | "completion-finalize";

function makeHarness(
  taskOverrides: Partial<TaskDetail> = {},
  provenance: AbortProvenance = "hard-cancel",
) {
  const store = createMockStore();
  const task = makeTask(taskOverrides);
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    autoMerge: true,
    maxAutoMergeRetries: 3,
  });
  store.recordRunAuditEvent = vi.fn();
  const executor = new TaskExecutor(store, "/tmp/test", {});
  (executor as any).markPausedAborted(task.id, provenance);
  return { store, task, executor };
}

async function invokeGraphFailure(
  executor: TaskExecutor,
  task: TaskDetail,
  resultOverrides: Record<string, unknown> = {},
) {
  await (executor as any).handleGraphFailure(task, {
    disposition: "failed",
    outcome: "failure",
    visitedNodeIds: ["plan", "execute"],
    context: {},
    ...resultOverrides,
  });
}

// Flush the unref'd setTimeout that schedules the in-place retry plus the async
// re-fetch + execute() chain inside it. Fake timers keep this deterministic
// (no real wall-clock wait) per the repo's no-slow-tests rule (FN-5048).
async function flushScheduledRetry() {
  await vi.advanceTimersByTimeAsync(10);
}

function logText(store: ReturnType<typeof createMockStore>): string {
  return store.logEntry.mock.calls.map((call: unknown[]) => call[1]).join("\n");
}

describe("pause-abort benign requeue-to-todo (FN-6782)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-continues the agent session for an engine-internal abort instead of re-queueing to todo", async () => {
    // An "engine abort during pause/resume" (pausedAborted hard-cancel, no user/
    // global pause) is engine-internal churn, not an operator action — the
    // executor must retry the agent session in place rather than bouncing the
    // task through todo (and must not fire a failure notification).
    const { store, task, executor } = makeHarness({ column: "todo" });
    (executor as any).addActiveWorktree(task.id, task.worktree);
    const executeSpy = vi
      .spyOn(executor as any, "execute")
      .mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task);

    // It must NOT park status:"failed" — that was the storm trigger.
    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(false);
    // It auto-continues instead of logging the benign re-queue line.
    expect(logText(store)).toContain("auto-continuing the agent session (1/2)");
    expect(logText(store)).not.toContain("benign, cleared for normal scheduling");
    // The bounded retry budget is incremented and any stale failure cleared.
    const bumpedRetry = store.updateTask.mock.calls.some(
      (call: unknown[]) => {
        const patch = call[1] as { graphResumeRetryCount?: number; status?: unknown } | undefined;
        return patch?.graphResumeRetryCount === 1 && patch?.status === null;
      },
    );
    expect(bumpedRetry).toBe(true);
    // An `Auto-recovered:`-prefixed log suppresses the failure notification.
    expect(logText(store)).toContain("Auto-recovered: engine-internal pause/resume abort");
    // The pause-abort marker is cleared and the worktree slot released.
    expect((executor as any).pausedAborted.has(task.id)).toBe(false);
    expect((executor as any).activeWorktrees.has(task.id)).toBe(false);
    // The agent session is re-executed in place after the backoff window.
    await flushScheduledRetry();
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "paused", patch: { paused: true } },
    { label: "user-paused", patch: { userPaused: true } },
    { label: "moved out of todo", patch: { column: "in-progress" } },
    { label: "deleted", patch: { deletedAt: "2026-06-21T00:00:00.000Z" } },
  ])(
    "fire-time guard: aborts the auto-continue when the task became $label during the backoff window",
    async ({ patch }) => {
      // The auto-continue re-fetches the task just before re-executing and must
      // bail if the operator paused/moved/deleted it during the backoff window —
      // the direct execute() bypasses the scheduler's pause filter, so without
      // this guard it would resume work the user just parked. The initial
      // `live` snapshot is a clean todo (so the auto-continue branch is entered
      // and a retry scheduled); the task then changes state before the timer
      // fires, and the fire-time re-fetch must abort the dispatch.
      const { store, task, executor } = makeHarness({ column: "todo" });
      (executor as any).addActiveWorktree(task.id, task.worktree);
      const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

      await invokeGraphFailure(executor, task);
      // The auto-continue branch was entered and a retry scheduled...
      expect(logText(store)).toContain("auto-continuing the agent session");

      // ...but the task changed state before the scheduled retry fires; the
      // fire-time re-fetch returns the mutated snapshot.
      store.getTask.mockResolvedValue({ ...task, ...patch } as typeof task);
      await flushScheduledRetry();

      expect(executeSpy).not.toHaveBeenCalled();
    },
  );

  it("clears a stale failed status when auto-continuing an engine-internal abort (no lingering failure notification)", async () => {
    // A pause-abort parked status:"failed" on an earlier non-todo observation
    // stays dispatchable (scheduler filters column+paused, not status) and
    // re-enters this branch in todo. Auto-continue must reconcile the row to
    // status:null/error:null — otherwise the persisted failure survives, the
    // board shows it failed, and the deferred failure notification fires.
    const { store, task, executor } = makeHarness({
      column: "todo",
      status: "failed",
      error: "Workflow graph failure surfaced after paused engine abort during pause/resume",
    });
    (executor as any).addActiveWorktree(task.id, task.worktree);
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task);

    const clearedFailure = store.updateTask.mock.calls.some(
      (call: unknown[]) => {
        const patch = call[1] as { status?: unknown; error?: unknown } | undefined;
        return patch?.status === null && patch?.error === null;
      },
    );
    expect(clearedFailure).toBe(true);
    const reParkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(reParkedFailed).toBe(false);
    expect(logText(store)).toContain("auto-continuing the agent session");
    expect(logText(store)).toContain("Auto-recovered: engine-internal pause/resume abort");
    await flushScheduledRetry();
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "explicit user pause",
      overrides: { column: "todo", userPaused: true },
      provenance: "hard-cancel" as const,
      expectedBenign: "benign, paused awaiting explicit unpause",
      expectedProvenance: "explicit user pause",
    },
    {
      label: "global pause",
      overrides: { column: "todo" },
      provenance: "global-pause" as const,
      expectedBenign: "benign, cleared for normal scheduling",
      expectedProvenance: "global pause",
    },
    {
      // FN-7851 pause-bounce regression: a pause-button pause that survived the
      // executor teardown via preservePause lands in todo with `paused: true`.
      // It must be classified as a task pause (NOT an engine-internal abort),
      // stay parked, and never auto-continue the session.
      label: "task pause (pause button, preserved across teardown)",
      overrides: { column: "todo", paused: true },
      provenance: "hard-cancel" as const,
      expectedBenign: "benign, paused awaiting explicit unpause",
      expectedProvenance: "task pause",
    },
  ])(
    "does NOT auto-resume a $label that landed in todo",
    async ({ overrides, provenance, expectedBenign, expectedProvenance }) => {
      // The auto-continue is scoped strictly to the engine-internal abort
      // provenance. A genuine operator pause (userPaused OR a preserved
      // pause-button `paused`) or a global engine pause that ended up in todo
      // must stay parked-benign and wait for explicit resume — auto-resuming it
      // would override the operator's intent.
      const { store, task, executor } = makeHarness(overrides, provenance);
      (executor as any).addActiveWorktree(task.id, task.worktree);
      const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

      await invokeGraphFailure(executor, task);

      expect(logText(store)).toContain(expectedBenign);
      expect(logText(store)).toContain(`during ${expectedProvenance} with task`);
      expect(logText(store)).not.toContain("auto-continuing the agent session");
      await flushScheduledRetry();
      expect(executeSpy).not.toHaveBeenCalled();
    },
  );

  it("falls back to a benign todo re-queue once internal retries are exhausted", async () => {
    // After MAX_TRANSIENT_GRAPH_RESUME_RETRIES (2) internal retries, a still-
    // wedged engine-internal abort must stop auto-continuing and fall through to
    // the benign re-queue (no failure notification, no retry storm).
    const { store, task, executor } = makeHarness({
      column: "todo",
      graphResumeRetryCount: 2,
    });
    (executor as any).addActiveWorktree(task.id, task.worktree);
    const executeSpy = vi
      .spyOn(executor as any, "execute")
      .mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task);

    expect(logText(store)).toContain("benign, cleared for normal scheduling");
    expect(logText(store)).not.toContain("auto-continuing the agent session");
    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(false);
    await flushScheduledRetry();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("clears a stale failed status on the retries-exhausted benign fallback", async () => {
    // The retries-exhausted fallback shares the benign re-queue's stale-failure
    // reconciliation: a row carrying status:"failed" from an earlier non-todo
    // observation must be cleared and emit the `Auto-recovered:` log so the
    // deferred failure notification is suppressed even when auto-continue is
    // exhausted.
    const { store, task, executor } = makeHarness({
      column: "todo",
      graphResumeRetryCount: 2,
      status: "failed",
      error: "Workflow graph failure surfaced after paused engine abort during pause/resume",
    });
    (executor as any).addActiveWorktree(task.id, task.worktree);

    await invokeGraphFailure(executor, task);

    expect(logText(store)).toContain("benign, cleared for normal scheduling");
    expect(logText(store)).toContain(
      "Auto-recovered: cleared stale pause-abort failure on todo re-queue",
    );
    const clearedFailure = store.updateTask.mock.calls.some(
      (call: unknown[]) => {
        const patch = call[1] as { status?: unknown; error?: unknown } | undefined;
        return patch?.status === null && patch?.error === null;
      },
    );
    expect(clearedFailure).toBe(true);
  });

  it("STILL parks a non-todo (in-review) pause-abort without a typed interrupted-node marker", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review" });

    await invokeGraphFailure(executor, task);

    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(true);
    expect(logText(store)).toContain("operator action required");
  });

  it("classifies an in-review typed plan interruption as stale without operator-action parking", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review" });
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      interruptedNodeId: "plan",
      interruptedAbortKind: "engine-pause",
      context: {
        "node:plan:value": "aborted",
        "node:plan:abortKind": "engine-pause",
        "workflow:interruptedNodeId": "plan",
        "workflow:interruptedNodeAbortKind": "engine-pause",
      },
    });

    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(false);
    expect(logText(store)).toContain("stale replay ignored, in-review state preserved");
    expect(logText(store)).not.toContain("operator action required");
    expect(store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { graphResumeRetryCount?: number } | undefined)?.graphResumeRetryCount !== undefined,
    )).toBe(false);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:classify-stale-in-review-plan-pause-abort-replay",
      metadata: expect.objectContaining({
        nodeId: "plan",
        fromColumn: "in-review",
        abortProvenance: "hard-cancel",
        mode: "preserved-in-review",
      }),
    }));
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
  });

  it("fire-time guard skips in-review graph re-entry when a graph run is already active", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review" });
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      interruptedNodeId: "execute",
      interruptedAbortKind: "engine-pause",
      context: { "node:execute:value": "aborted", "node:execute:abortKind": "engine-pause" },
    });

    (executor as any).activeWorkflowGraphAbortControllers.set(task.id, new AbortController());
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
  });

  it("does NOT auto-recover an explicit user pause even with an interrupted-node marker", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review", userPaused: true });
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      interruptedNodeId: "plan",
      interruptedAbortKind: "engine-pause",
      context: { "node:plan:value": "aborted", "node:plan:abortKind": "engine-pause" },
    });

    expect(logText(store)).toContain("operator action required");
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
  });

  it("auto-recovers an in-review paused-aborted execute node through graph re-entry", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review" });
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      interruptedNodeId: "execute",
      interruptedAbortKind: "engine-pause",
      context: { "node:execute:value": "aborted", "node:execute:abortKind": "engine-pause" },
    });

    expect(logText(store)).toContain("Auto-recovered: re-entering paused-aborted workflow graph node 'execute'");
    expect(logText(store)).not.toContain("operator action required");
    await flushScheduledRetry();
    expect(graphSpy).toHaveBeenCalledTimes(1);
  });

  it("auto-recovers a todo paused-aborted execute node by re-executing the task", async () => {
    const { store, task, executor } = makeHarness({ column: "todo" });
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      interruptedNodeId: "execute",
      interruptedAbortKind: "engine-pause",
      context: { "node:execute:value": "aborted", "node:execute:abortKind": "engine-pause" },
    });

    expect(logText(store)).toContain("Auto-recovered: re-entering paused-aborted workflow graph node 'execute'");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reenter-paused-aborted-workflow-node",
      metadata: expect.objectContaining({ nodeId: "execute", fromColumn: "todo", mode: "reexecuted-from-todo" }),
    }));
    await flushScheduledRetry();
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("classifies a stale in-review plan pause/resume replay as benign without re-entering planning", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review", graphResumeRetryCount: 2 });
    (executor as any).addActiveWorktree(task.id, task.worktree);
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["plan"],
      context: { "node:plan:value": "aborted" },
    });

    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(false);
    expect(logText(store)).toContain("stale replay ignored, in-review state preserved");
    expect(logText(store)).not.toContain("operator action required");
    expect(store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { graphResumeRetryCount?: number } | undefined)?.graphResumeRetryCount !== undefined,
    )).toBe(false);
    expect((executor as any).pausedAborted.has(task.id)).toBe(false);
    expect((executor as any).activeWorktrees.has(task.id)).toBe(false);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:classify-stale-in-review-plan-pause-abort-replay",
      metadata: expect.objectContaining({
        nodeId: "plan",
        fromColumn: "in-review",
        abortProvenance: "hard-cancel",
        clearedStaleFailure: false,
        graphResumeRetryCount: 2,
        mode: "preserved-in-review",
      }),
    }));
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("clears a prior stale operator-action failure for an in-review plan replay", async () => {
    const { store, task, executor } = makeHarness({
      column: "in-review",
      status: "failed",
      error: "Workflow graph failure surfaced after paused engine abort during pause/resume in 'in-review' at node 'plan' — operator action required; retry or explicitly unpause/resume after inspecting the task",
    });
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["plan"],
      context: { "node:plan:value": "aborted" },
    });

    expect(logText(store)).toContain("Auto-recovered: cleared stale in-review plan pause/resume replay failure");
    expect(store.updateTask.mock.calls.some(
      (call: unknown[]) => {
        const patch = call[1] as { status?: unknown; error?: unknown } | undefined;
        return patch?.status === null && patch?.error === null;
      },
    )).toBe(true);
    expect(store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    )).toBe(false);
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
  });

  it("auto-retries a stale in-review parse pause/resume replay instead of requiring operator action", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review", graphResumeRetryCount: 0 });
    (executor as any).addActiveWorktree(task.id, task.worktree);
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["parse"],
      context: { "node:parse:value": "aborted" },
    });

    const parkedFailed = store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    );
    expect(parkedFailed).toBe(false);
    expect(logText(store)).toContain("parse node pause/resume replay surfaced after task was already in-review — auto-retrying workflow graph (1/2)");
    expect(logText(store)).toContain("Auto-recovered: retrying stale in-review parse pause/resume replay");
    expect(logText(store)).not.toContain("operator action required");
    expect(store.updateTask).toHaveBeenCalledWith(task.id, {
      graphResumeRetryCount: 1,
      status: null,
      error: null,
    }, undefined);
    expect((executor as any).pausedAborted.has(task.id)).toBe(false);
    expect((executor as any).activeWorktrees.has(task.id)).toBe(false);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:retry-stale-in-review-parse-pause-abort-replay",
      metadata: expect.objectContaining({
        nodeId: "parse",
        fromColumn: "in-review",
        attempt: 1,
        abortProvenance: "hard-cancel",
        clearedStaleFailure: false,
        mode: "preserved-in-review-retry-graph",
      }),
    }));
    await flushScheduledRetry();
    expect(graphSpy).toHaveBeenCalledTimes(1);
  });

  it("clears a prior stale operator-action failure for an in-review parse replay and retries", async () => {
    const { store, task, executor } = makeHarness({
      column: "in-review",
      status: "failed",
      error: "Workflow graph failure surfaced after paused engine abort during pause/resume in 'in-review' at node 'parse' — operator action required; retry or explicitly unpause/resume after inspecting the task",
    });
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["parse"],
      context: { "node:parse:value": "aborted" },
    });

    expect(logText(store)).toContain("Auto-recovered: retrying stale in-review parse pause/resume replay");
    expect(store.updateTask).toHaveBeenCalledWith(task.id, {
      graphResumeRetryCount: 1,
      status: null,
      error: null,
    }, undefined);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:retry-stale-in-review-parse-pause-abort-replay",
      metadata: expect.objectContaining({ nodeId: "parse", clearedStaleFailure: true }),
    }));
    store.getTask.mockResolvedValue({ ...task, status: null, error: null, graphResumeRetryCount: 1 });
    await flushScheduledRetry();
    expect(graphSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps manual retry of a prior plan pause-abort park in review instead of fresh planning", async () => {
    const { store, task, executor } = makeHarness({
      column: "in-review",
      status: null,
      error: null,
      log: [{
        action: "Workflow graph failure surfaced after paused engine abort during pause/resume in 'in-review' at node 'plan' — operator action required; retry or explicitly unpause/resume after inspecting the task",
        timestamp: now,
      }],
    });
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["plan"],
      context: { "node:plan:value": "aborted" },
    });

    expect(logText(store)).toContain("stale replay ignored, in-review state preserved");
    expect(store.updateTask.mock.calls.some(
      (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
    )).toBe(false);
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("does NOT classify a global-pause generic plan replay while global pause remains active", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review" }, "global-pause");
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      autoMerge: true,
      globalPause: true,
      maxAutoMergeRetries: 3,
    });

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["plan"],
      context: { "node:plan:value": "aborted" },
    });

    expect(logText(store)).toContain("operator action required");
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:classify-stale-in-review-plan-pause-abort-replay",
    }));
  });

  it.each([
    { label: "explicit user pause", overrides: { userPaused: true }, value: "aborted" },
    { label: "task pause", overrides: { paused: true }, value: "aborted" },
    { label: "non-clean real failure", overrides: { status: "failed", error: "plugin handler failed" }, value: "aborted" },
    { label: "human-gated autoMerge:false row", overrides: { autoMerge: false }, value: "aborted" },
    { label: "terminal contamination value", overrides: {}, value: "foreign-branch-contamination" },
  ])("does NOT classify a $label as stale in-review plan replay", async ({ overrides, value }) => {
    const { store, task, executor } = makeHarness({ column: "in-review", ...overrides });

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["plan"],
      context: { "node:plan:value": value },
    });

    expect(logText(store)).toContain("operator action required");
    expect(logText(store)).not.toContain("stale replay ignored");
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:classify-stale-in-review-plan-pause-abort-replay",
    }));
  });

  it("keeps the completed in-review pause-abort classifier distinct from stale plan replay", async () => {
    const { store, task, executor } = makeHarness({
      column: "in-review",
      steps: [{ name: "Implement", status: "done" }],
    });

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["plan"],
      context: { "node:plan:value": "aborted" },
    });

    expect(logText(store)).toContain("Workflow graph run ended during engine pause/resume while already in-review");
    expect(logText(store)).not.toContain("stale replay ignored");
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:classify-stale-in-review-plan-pause-abort-replay",
    }));
  });

  it("STILL parks a genuine in-review node failure with no paused-node audit", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review" });
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["plan"],
      context: { "node:plan:value": "REVISE" },
    });

    expect(logText(store)).toContain("operator action required");
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reenter-paused-aborted-workflow-node",
    }));
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
  });

  it("classifies a global-pause in-review plan interruption after global resume", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review" }, "global-pause");
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      interruptedNodeId: "plan",
      interruptedAbortKind: "engine-pause",
      context: { "node:plan:value": "aborted", "node:plan:abortKind": "engine-pause" },
    });

    expect(logText(store)).toContain("stale replay ignored, in-review state preserved");
    expect(logText(store)).not.toContain("operator action required");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:classify-stale-in-review-plan-pause-abort-replay",
      metadata: expect.objectContaining({
        nodeId: "plan",
        fromColumn: "in-review",
        abortProvenance: "global-pause",
        mode: "preserved-in-review",
      }),
    }));
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
  });

  it("classifies a global-pause in-review plan replay without an interrupted-node marker after global resume", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review" }, "global-pause");
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      visitedNodeIds: ["plan"],
      context: { "node:plan:value": "aborted" },
    });

    expect(logText(store)).toContain("stale replay ignored, in-review state preserved");
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reenter-paused-aborted-workflow-node",
    }));
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
  });

  it("does NOT auto-recover a global-pause interrupted node while global pause is still active", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review" }, "global-pause");
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      autoMerge: true,
      globalPause: true,
      maxAutoMergeRetries: 3,
    });
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      interruptedNodeId: "plan",
      interruptedAbortKind: "engine-pause",
      context: { "node:plan:value": "aborted", "node:plan:abortKind": "engine-pause" },
    });

    expect(logText(store)).toContain("operator action required");
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
  });

  it("does NOT auto-recover an autoMerge:false in-review interrupted node", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review", autoMerge: false });
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      interruptedNodeId: "plan",
      interruptedAbortKind: "engine-pause",
      context: { "node:plan:value": "aborted", "node:plan:abortKind": "engine-pause" },
    });

    expect(logText(store)).toContain("operator action required");
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
  });

  it("does NOT auto-recover an exhausted in-review interrupted node", async () => {
    const { store, task, executor } = makeHarness({ column: "in-review", graphResumeRetryCount: 2 });
    const graphSpy = vi.spyOn(executor as any, "executeWorkflowGraph").mockResolvedValue(undefined);

    await invokeGraphFailure(executor, task, {
      interruptedNodeId: "execute",
      interruptedAbortKind: "engine-pause",
      context: { "node:execute:value": "aborted", "node:execute:abortKind": "engine-pause" },
    });

    expect(logText(store)).toContain("operator action required");
    await flushScheduledRetry();
    expect(graphSpy).not.toHaveBeenCalled();
  });

  /*
  FNXC:WorkflowLifecycle 2026-07-12:
  Live-acceptance repro: the workflow merge boundary hard-cancels the in-flight
  executor session on the in-progress → in-review move, the AI merge lands, the
  task advances to done — and the aborted graph run's teardown then reached the
  operator-action sink and logged "operator action required" on a task that
  finished perfectly. A pause-abort observed in a terminal SUCCESS column must
  be benign across BOTH terminal columns (done and archived): no alarming log,
  no failed park, marker cleared, worktree slot released.
  */
  describe("terminal-success columns are benign (post-merge hard-cancel false alarm)", () => {
    it.each([
      { column: "done" as const },
      { column: "archived" as const },
    ])("classifies a hard-cancel pause abort on a '$column' task as benign", async ({ column }) => {
      const { store, task, executor } = makeHarness({ column });
      (executor as any).addActiveWorktree(task.id, task.worktree);

      await invokeGraphFailure(executor, task, {
        interruptedNodeId: "merge",
        interruptedAbortKind: "engine-pause",
        visitedNodeIds: ["plan", "execute", "merge"],
        context: { "node:merge:value": "merged", "node:merge:abortKind": "engine-pause" },
      });

      // No operator-action alarm and no PAUSE_ABORT_PARK markers in the log.
      expect(logText(store)).not.toContain("operator action required");
      expect(logText(store)).not.toContain("Workflow graph failure surfaced");
      // The benign completion note is logged instead.
      expect(logText(store)).toContain(`after the task already completed ('${column}') — benign, no action needed`);
      // Never parked failed.
      const parkedFailed = store.updateTask.mock.calls.some(
        (call: unknown[]) => (call[1] as { status?: string } | undefined)?.status === "failed",
      );
      expect(parkedFailed).toBe(false);
      // Marker cleared + worktree slot released so nothing re-fires or leaks.
      expect((executor as any).pausedAborted.has(task.id)).toBe(false);
      expect((executor as any).activeWorktrees.has(task.id)).toBe(false);
    });
  });
});

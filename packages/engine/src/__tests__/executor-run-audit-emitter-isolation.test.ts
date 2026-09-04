import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import type { Task, TaskDetail, WorkflowIr } from "@fusion/core";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { MAX_EXECUTE_REQUEUE_LOOP_CYCLES, TaskExecutor } from "../executor.js";
import { createTaskDoneTool } from "../executor/create-task-done-tool.js";
import { parkCompletedBlockedTask } from "../executor/completion-finalization.js";
import { acquireSessionRegistryPath } from "../executor/acquire-session-registry-path.js";
import { advanceNoMergeWorkflowToCompleteColumn } from "../executor/no-merge-complete-column.js";
import { recoverMissingRequiredArtifacts } from "../executor/required-artifact-recovery.js";
import { handleStaleInReviewPlanPauseAbortReplay } from "../executor/handle-stale-in-review-plan-pause-abort-replay.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const NO_MERGE_IR = {
  version: "v2", id: "wf-audit", name: "audit", nodes: [], edges: [],
  columns: [
    { id: "working", name: "Working", traits: [] },
    { id: "complete", name: "Complete", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

const sinkStates = {
  rejected: () => vi.fn().mockRejectedValue(new Error("audit sink down")),
  synchronousThrow: () => vi.fn(() => { throw new Error("sync boom"); }),
  hanging: () => vi.fn(() => new Promise<void>(() => {})),
};

async function settleBounded<T>(invoke: () => Promise<T>, hanging: boolean): Promise<T> {
  if (!hanging) return await invoke();
  vi.useFakeTimers();
  try {
    const result = invoke();
    await vi.advanceTimersByTimeAsync(2_000);
    const settled = await result;
    // FNXC:RunAudit 2026-08-20-03:24: Run the zero-delay lifecycle continuation scheduled after the bounded emit.
    await vi.runOnlyPendingTimersAsync();
    return settled;
  } finally {
    vi.useRealTimers();
  }
}

/**
 * FNXC:RunAudit 2026-08-20-03:18:
 * FN-9172 regression coverage drives executor entry points instead of the emit seam alone. The
 * lifecycle write/log/return following each historical shape must remain observable when the
 * store's real audit method rejects, hangs, or throws synchronously.
 */
describe("FN-9172 executor run-audit emitter isolation", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockImplementation(() => Buffer.from(""));
  });

  afterEach(() => activeSessionRegistry.clear());

  it.each(Object.entries(sinkStates))("keeps the terminal dispatch-loop park and token persistence moving after a %s sink", async (state, makeSink) => {
    const store = createMockStore() as any;
    const task = {
      id: "FN-LOOP", title: "loop", description: "", column: "todo", dependencies: [],
      steps: [{ name: "Implement", status: "in-progress" }], currentStep: 0, log: [],
      status: null, error: null, paused: false, userPaused: false, autoMerge: true,
      executeRequeueLoopCount: MAX_EXECUTE_REQUEUE_LOOP_CYCLES - 1,
      executeRequeueLoopSignature: "execute|implementation-incomplete",
    } as any;
    store.getTask.mockResolvedValue(task);
    store.getSettings.mockResolvedValue({ executorToolFailureRetryCount: 0 });
    store.updateTask.mockImplementation(async (_id: string, patch: object) => Object.assign(task, patch));
    store.recordRunAuditEvent = makeSink();
    const executor = new TaskExecutor(store, "/repo") as any;
    const persistTokenUsage = vi.spyOn(executor, "persistTokenUsage").mockResolvedValue(undefined);

    await settleBounded(() => executor.handleGraphFailure(task, {
      disposition: "failed", outcome: "failure", visitedNodeIds: ["execute"],
      context: { "node:execute:value": "implementation-incomplete" },
    }), state === "hanging");

    expect(task).toMatchObject({ status: "failed", error: expect.stringMatching(/^EXECUTION_DISPATCH_LOOP_EXHAUSTED:/) });
    expect(persistTokenUsage).toHaveBeenCalledWith("FN-LOOP");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:execution-dispatch-loop-terminalized" }));
  });

  it.each(Object.entries(sinkStates))("keeps the tool-failure retry lane schedulable after a %s sink", async (state, makeSink) => {
    const store = createMockStore() as any;
    const task = {
      id: "FN-RETRY", title: "retry", description: "", column: "in-progress", dependencies: [],
      steps: [{ name: "Implement", status: "in-progress" }], currentStep: 0, log: [],
      status: null, error: null, paused: false, userPaused: false, autoMerge: true,
      toolFailureDetectorLogCursor: 0,
    } as any;
    store.getTask.mockResolvedValue(task);
    store.getSettings.mockResolvedValue({ executorToolFailureRetryCount: 1, executorToolFailureRetryBackoffMs: 0 });
    store.getAgentLogCount = vi.fn().mockResolvedValue(1);
    store.getAgentLogs = vi.fn().mockResolvedValue([{ type: "tool_error" }]);
    store.claimNextToolFailureRetry = vi.fn().mockResolvedValue({ outcome: "claimed", attempt: 1 });
    store.recordRunAuditEvent = makeSink();
    const executor = new TaskExecutor(store, "/repo") as any;
    executor.graphToolFailureRunCursors.set(task.id, 0);
    const execute = vi.spyOn(executor, "execute").mockResolvedValue(undefined);

    await settleBounded(() => executor.handleGraphFailure(task, {
      disposition: "failed", outcome: "failure", visitedNodeIds: ["steps#0:step-execute"],
      context: { "node:steps#0:step-execute:value": "failure" },
    }), state === "hanging");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.updateTask).toHaveBeenCalledWith("FN-RETRY", { status: null, error: null }, undefined);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:execution-tool-failure-retry" }));
    expect(execute).toHaveBeenCalledWith(task);
  });

  it.each(Object.entries(sinkStates))("keeps Shape-A no-merge completion moving after a %s sink", async (state, makeSink) => {
    const recordRunAuditEvent = makeSink();
    const moveTask = vi.fn().mockResolvedValue(undefined);
    const store = {
      getTaskWorkflowSelection: () => ({ workflowId: "wf-audit", stepIds: [] }),
      getTaskWorkflowSelectionAsync: async () => ({ workflowId: "wf-audit", stepIds: [] }),
      getWorkflowDefinition: async () => ({ ir: NO_MERGE_IR }),
      moveTask,
      recordRunAuditEvent,
    } as any;

    await settleBounded(
      () => advanceNoMergeWorkflowToCompleteColumn(store, { id: "FN-A", column: "working", steps: [] } as TaskDetail),
      state === "hanging",
    );

    expect(moveTask).toHaveBeenCalledWith("FN-A", "complete", expect.any(Object));
    expect(recordRunAuditEvent).toHaveBeenCalledOnce();
  });

  it.each(Object.entries(sinkStates))("keeps Shape-A artifact recovery applying its follow-up after a %s sink", async (state, makeSink) => {
    const recordRunAuditEvent = makeSink();
    const task = { id: "FN-ARTIFACT", column: "todo", steps: [], recoveryRetryCount: 0 } as Task;
    const updateTask = vi.fn().mockResolvedValue(undefined);
    const store = {
      getTask: vi.fn().mockResolvedValue(task),
      getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
      getTaskWorkflowSelectionAsync: async () => ({ workflowId: "builtin:coding", stepIds: [] }),
      getWorkflowDefinition: async () => ({ ir: { version: "v2", columns: [{ id: "todo", traits: [{ trait: "hold", config: { release: "manual" } }] }] } }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn().mockResolvedValue(undefined),
      updateTask,
      recordRunAuditEvent,
    } as any;

    await settleBounded(() => recoverMissingRequiredArtifacts({
      store,
      getRunContextFor: () => undefined,
      isRequiredArtifactRecoveryProtected: async () => false,
      workflowLifecycleMovesInFlight: new Set(),
    }, task, ["plan"], { source: "graph-entry" }), state === "hanging");

    expect(recordRunAuditEvent).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenCalledWith("FN-ARTIFACT", expect.objectContaining({ status: null }), undefined);
  });

  it.each(Object.entries(sinkStates))("keeps completed-blocked parks returning true after a %s sink", async (state, makeSink) => {
    const task = { id: "FN-PARK", column: "todo", status: null, paused: false, userPaused: false, steps: [{ status: "done" }] } as any;
    const updateTask = vi.fn().mockResolvedValue(undefined);
    const moveTask = vi.fn().mockResolvedValue(undefined);
    const store = {
      getTask: vi.fn().mockResolvedValue(task),
      getTaskWorkflowSelection: () => undefined,
      getTaskWorkflowSelectionAsync: async () => undefined,
      moveTask,
      updateTask,
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: makeSink(),
    } as any;

    const result = await settleBounded(() => parkCompletedBlockedTask({
      store, getRunContextFor: () => undefined, getTaskCompletionBlocker: async () => "dependency",
    }, task, "dependency", "test", true), state === "hanging");

    expect(result).toBe(true);
    expect(updateTask).toHaveBeenCalledWith("FN-PARK", expect.objectContaining({ paused: true, status: "queued" }), undefined);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:completed-blocked-parked" }));
  });

  it.each(Object.entries(sinkStates))("keeps the fn_task_done blocked exit persisting tokens after a %s sink", async (state, makeSink) => {
    const task = { id: "FN-DONE", column: "in-progress", dependencies: [], log: [], steps: [{ status: "in-progress" }] } as any;
    const persistTokenUsage = vi.fn().mockResolvedValue(undefined);
    const store = {
      getTask: vi.fn().mockResolvedValue(task), updateTask: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn().mockResolvedValue(undefined), logEntry: vi.fn().mockResolvedValue(undefined), recordRunAuditEvent: makeSink(),
    } as any;
    const tool = createTaskDoneTool({
      store, getRunContextFor: () => undefined, persistTokenUsage, workflowLifecycleMovesInFlight: new Set(),
    } as any, task.id, "/repo", "", new Map());

    const result = await settleBounded(() => tool.execute("call", {
      outcome: "blocked", obstacle: "inside-worktree", reason: "upstream dependency", blockedBy: ["FN-9999"],
    }), state === "hanging");

    expect(result.content[0]?.text).toContain("parked as blocked");
    expect(persistTokenUsage).toHaveBeenCalledWith("FN-DONE");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:execution-blocked-parked" }));
  });

  it.each(Object.entries(sinkStates))("keeps Shape-B stale-plan replay returning true after a %s sink", async (state, makeSink) => {
    const recordRunAuditEvent = makeSink();
    const persistTokenUsage = vi.fn().mockResolvedValue(undefined);
    const live = { id: "FN-B", column: "review", status: null, error: null, autoMerge: true, steps: [] } as TaskDetail;
    const result = await settleBounded(() => handleStaleInReviewPlanPauseAbortReplay({
      store: { getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }), logEntry: vi.fn(), recordRunAuditEvent } as any,
      getRunContextFor: () => undefined,
      resolveResumeLanes: async () => ({ review: "review" }) as any,
      isLiveSharedBranchGroupMember: async () => false,
      clearPausedAborted: vi.fn(),
      activeWorktrees: new Map(),
      persistTokenUsage,
    }, live, {
      interruptedNodeId: "plan", visitedNodeIds: ["plan"], context: { "node:plan:value": "aborted" },
    } as any, "global-pause", true, false), state === "hanging");

    expect(result).toBe(true);
    expect(persistTokenUsage).toHaveBeenCalledWith("FN-B");
    expect(recordRunAuditEvent).toHaveBeenCalledOnce();
  });

  it.each(Object.entries(sinkStates))("keeps Shape-C workflow suspension returning after a %s sink", async (state, makeSink) => {
    const store = createMockStore() as any;
    const task = { id: "FN-C", column: "in-progress", steps: [], dependencies: [] } as any;
    store.getTask.mockResolvedValue(task);
    store.getSettings.mockResolvedValue({ experimentalFeatures: { workflowGraphExecutor: true } });
    store.getTaskWorkflowSelectionAsync = vi.fn().mockResolvedValue({ workflowId: "wf-c", stepIds: [] });
    store.getWorkflowDefinition = vi.fn().mockResolvedValue({ id: "wf-c", ir: { version: "v2", columns: [], nodes: [], edges: [] } });
    store.recordRunAuditEvent = makeSink();
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockResolvedValue({
      disposition: "suspended", outcome: "failure", visitedNodeIds: [], suspension: { nodeId: "wait", reason: "manual", fromColumn: "in-progress", toColumn: "todo" },
    } as any);
    try {
      const executor = new TaskExecutor(store, "/repo") as any;
      await settleBounded(() => executor.executeWorkflowGraph(task), state === "hanging");
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:workflow-run-suspended" }));
    } finally {
      run.mockRestore();
    }
  });

  it.each([
    ["absent", undefined, false],
    ["throwing", () => vi.fn(() => { throw new Error("audit throw"); }), false],
    ["rejecting", () => vi.fn(() => Promise.reject(new Error("audit reject"))), false],
    ["hanging", () => vi.fn(() => new Promise<void>(() => {})), true],
    ["late-settling", () => vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 5_000))), true],
  ] as const)("keeps a repaired review verdict unchanged with an %s audit sink", async (_state, makeSink, bounded) => {
    const store = createMockStore() as any;
    const task = {
      id: "FN-VERDICT-AUDIT", title: "verdict", description: "verdict", column: "in-progress",
      dependencies: [], steps: [{ name: "Implement", status: "done" }], currentStep: 0, log: [],
      worktree: "/repo/.worktrees/verdict", branch: "fusion/verdict", baseCommitSha: "abc123",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as any;
    store.getTask.mockResolvedValue(task);
    const recordRunAuditEvent = makeSink?.();
    if (recordRunAuditEvent) store.recordRunAuditEvent = recordRunAuditEvent;
    const listeners: Array<(event: any) => void> = [];
    let reply = 0;
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        state: {},
        subscribe: (listener: (event: any) => void) => { listeners.push(listener); return () => {}; },
        prompt: vi.fn(async () => {
          const output = reply++ === 0
            ? "I inspected the scoped diff and found no correctness defects."
            : '{"verdict":"APPROVE"}';
          for (const listener of listeners) listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: output },
          });
        }),
        dispose: vi.fn(),
      },
    } as any);
    const executor = new TaskExecutor(store, "/repo", {
      agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
    } as any) as any;
    vi.spyOn(executor, "getRunContextFor").mockReturnValue({
      taskId: task.id, agentId: "reviewer", runId: "run-verdict-audit", phase: "execute",
    });
    const step = {
      id: "graph:quality-review", name: "Quality Review", description: "", mode: "prompt",
      phase: "pre-merge", gateMode: "gate", prompt: "Review.", toolMode: "readonly",
      enabled: true, createdAt: task.createdAt, updatedAt: task.updatedAt,
    };

    const outcome = await settleBounded(
      () => executor.executeWorkflowStep(task, step, task.worktree, { workflowStepTimeoutMs: 60_000 }),
      bounded,
    );

    expect(outcome).toMatchObject({ success: true, verdict: "APPROVE" });
    if (recordRunAuditEvent) {
      expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "task:review-verdict-repaired",
      }));
    }
  });

  it.each(Object.entries(sinkStates))("keeps synchronous Shape-D session acquisition alive after a %s sink", async (_state, makeSink) => {
    const recordRunAuditEvent = makeSink();
    const path = "/repo/.worktrees/reclaimed";
    activeSessionRegistry.registerPath(path, { taskId: "FN-OLD", kind: "executor", ownerKey: "old" });
    const now = Date.now;
    vi.spyOn(Date, "now").mockReturnValue(now() + 60_000);
    try {
      expect(() => acquireSessionRegistryPath({ store: { recordRunAuditEvent } as any, hasLiveTaskSessionSurface: () => false }, "FN-D", path, "executor", "new")).not.toThrow();
      expect(activeSessionRegistry.lookupByPath(path)).toMatchObject({ taskId: "FN-D" });
      // Fire-and-forget emission begins synchronously; it is never permitted to throw into this API.
      expect(recordRunAuditEvent).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// -nocheck
import { describe, it, expect, beforeEach, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { graphActiveContextKey } from "../executor/task-predicates.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import type { Task, WorkflowIr } from "@fusion/core";
import { WorktreeBaseRefreshError } from "../worktree/worktree-acquisition.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { graphFailureValue, graphFailureErrorTexts, isWorktreeBaseRefreshGraphFailure } from "../executor/graph-failure-pure.js";

/**
 * FIX 3: runGraphTaskStep single-flight-per-attempt + rejection memo clearing.
 *
 * The implementation phase is memoized once per run (graphStepRunOnce) so each
 * foreach instance's runStep observes the projection instead of re-running the
 * agent. Two regressions are covered:
 *   - a REJECTED phase must clear the memo so a rework cycle RE-INVOKES the
 *     implementation (the prior code re-awaited the stored rejection forever);
 *   - the projection consult must NOT mask a step-session failure: a non-terminal
 *     step with no deferred review returns success:false (the prior code returned
 *     success on both branches).
 */
describe("runGraphTaskStep (FIX 3)", () => {
  beforeEach(() => resetExecutorMocks());

  function makeExecutor(stepStatus: string | undefined, active?: { deferDoneToReview?: boolean }) {
    const store = createMockStore();
    store.getTask = vi.fn().mockResolvedValue({
      id: "FN-001",
      steps: stepStatus ? [{ name: "S1", status: stepStatus }] : [{ name: "S1", status: "pending" }],
    });
    const executor: any = new TaskExecutor(store, "/tmp/test", {});
    /*
    FNXC:WorkflowGraph 2026-08-12-01:13:
    The composite foreach key moved from TaskExecutor to a module helper; tests must use the imported helper
    while graphStepActiveContext remains a protected instance field.
    */
    if (active) {
      executor.graphStepActiveContext.set(
        graphActiveContextKey("FN-001", "inst-0"),
        { stepIndex: 0, instanceId: "inst-0", ...active },
      );
    }
    return { executor, store };
  }

  const task = { id: "FN-001" } as Task;

  /* FNXC:WorktreeBaseRefresh 2026-09-19-20:13: Prove the actual step adapter and foreach preserve the typed refusal instead of the FN-9313 step-failed symptom. */
  it.each([false, true])("routes an unsafe checkout through the real foreach seam (deferred review=%s)", async (deferDoneToReview) => {
    const { executor } = makeExecutor("pending", { deferDoneToReview });
    const error = new WorktreeBaseRefreshError({ kind: "base-reconciliation-required", executionSafe: false, detail: "existing rebase-merge" });
    executor.runImplementationPhase = vi.fn().mockRejectedValue(error);
    const graph = new WorkflowGraphExecutor({ seams: executor.createAuthoritativeWorkflowSeams({}), maxRetriesPerNode: 3 });
    const ir: WorkflowIr = {
      version: "v2", name: "refresh-refusal", columns: [{ id: "in-progress", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "steps", kind: "foreach", config: { source: "task-steps", template: {
          nodes: [{ id: "step-execute", kind: "prompt", config: { seam: "step-execute" } }], edges: [],
        } } },
        { id: "end", kind: "end" },
      ],
      edges: [{ from: "start", to: "steps" }, { from: "steps", to: "end", condition: "success" }],
    };
    const result = await graph.run({ ...task, column: "in-progress", steps: [{ name: "Preflight", status: "pending" }] } as any, {}, ir);
    const failure = { ...result, disposition: "failed" as const };
    expect(result.outcome).toBe("failure");
    expect(result.visitedNodeIds).toContain("steps#0:step-execute");
    expect(graphFailureValue(failure)).toBe("base-reconciliation-required");
    expect(isWorktreeBaseRefreshGraphFailure(failure)).toBe(true);
    expect(graphFailureErrorTexts(failure).join(" ")).toContain("existing rebase-merge");
    expect(executor.runImplementationPhase).toHaveBeenCalledOnce();
    expect(executor.graphStepRunOnce.has(task.id)).toBe(false);
  });

  it.each(["pending", "in-progress", "done", "skipped"])("does not turn a refresh refusal into completion for %s projection", async (status) => {
    const { executor } = makeExecutor(status, { deferDoneToReview: true });
    const refusal = new WorktreeBaseRefreshError({ kind: "base-reconciliation-required", executionSafe: false });
    executor.runImplementationPhase = vi.fn().mockRejectedValue(refusal);
    await expect(executor.runGraphTaskStep(task, 0)).rejects.toBe(refusal);
  });

  it.each(["ready", "paused", "deleted", "live-session", "engine-paused", "exhausted"])("bounds refresh recovery and rechecks %s at timer fire", async (scenario) => {
    vi.useFakeTimers();
    try {
      const { executor, store } = makeExecutor("pending");
      const live = { id: task.id, column: "in-progress", steps: [{ name: "Preflight", status: "in-progress" }], graphResumeRetryCount: scenario === "exhausted" ? 2 : 0 } as any;
      store.getTask.mockResolvedValue(live);
      executor.execute = vi.fn().mockResolvedValue(undefined);
      executor.hasLiveTaskSessionSurface = vi.fn().mockReturnValue(false);
      await executor.handleGraphFailure(live, {
        disposition: "failed", outcome: "failure", visitedNodeIds: ["steps", "steps#0:step-execute"],
        context: { "node:steps:value": "base-reconciliation-required" },
      });
      if (scenario === "paused") live.paused = true;
      if (scenario === "deleted") live.deletedAt = new Date().toISOString();
      if (scenario === "live-session") executor.hasLiveTaskSessionSurface.mockReturnValue(true);
      if (scenario === "engine-paused") store.getSettings.mockResolvedValue({ enginePaused: true });
      await vi.runAllTimersAsync();
      expect(executor.execute).toHaveBeenCalledTimes(scenario === "ready" ? 1 : 0);
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.updateTask.mock.calls.some(([, patch]) => patch?.status === "failed")).toBe(false);
      if (scenario === "exhausted") expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("retry budget exhausted"), undefined, undefined);
      else expect(store.updateTask).toHaveBeenCalledWith(task.id, { graphResumeRetryCount: 1 }, undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-invokes the implementation after a rejected phase (rework retries)", async () => {
    const { executor } = makeExecutor("pending", { deferDoneToReview: true });
    let calls = 0;
    executor.runImplementationPhase = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("impl failed");
      return { taskDone: true, modifiedFiles: [] };
    });

    // First attempt: implementation rejects → failure, memo cleared.
    const first = await executor.runGraphTaskStep(task, 0);
    expect(first.success).toBe(false);
    expect(calls).toBe(1);

    // Rework re-run: the memo was cleared, so the implementation is invoked AGAIN
    // (the bug left a poisoned rejected promise that was re-awaited forever).
    const second = await executor.runGraphTaskStep(task, 0);
    expect(calls).toBe(2);
    expect(second.success).toBe(true);
  });

  it("single-flight within one attempt: concurrent callers share one phase", async () => {
    const { executor } = makeExecutor("done");
    let calls = 0;
    executor.runImplementationPhase = vi.fn().mockImplementation(async () => {
      calls += 1;
      await Promise.resolve();
      return { taskDone: true, modifiedFiles: [] };
    });
    const [a, b] = await Promise.all([
      executor.runGraphTaskStep(task, 0),
      executor.runGraphTaskStep(task, 0),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(calls).toBe(1); // memoized — exactly one implementation pass.
  });

  it("does NOT mask a step-session failure: non-terminal step without review → failure", async () => {
    const { executor } = makeExecutor("in-progress"); // never reaches done/skipped, no deferDoneToReview
    executor.runImplementationPhase = vi.fn().mockResolvedValue({ taskDone: false, modifiedFiles: [] });
    const result = await executor.runGraphTaskStep(task, 0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not completed/);
  });

  it("deferDoneToReview: a non-terminal step is success (review authors done)", async () => {
    const { executor } = makeExecutor("in-progress", { deferDoneToReview: true });
    executor.runImplementationPhase = vi.fn().mockResolvedValue({ taskDone: false, modifiedFiles: [] });
    const result = await executor.runGraphTaskStep(task, 0);
    expect(result.success).toBe(true);
  });

  it("terminal step (done) is success regardless of review", async () => {
    const { executor } = makeExecutor("done");
    executor.runImplementationPhase = vi.fn().mockResolvedValue({ taskDone: true, modifiedFiles: [] });
    const result = await executor.runGraphTaskStep(task, 0);
    expect(result.success).toBe(true);
  });

  it("does not force step-session mode for final-review coding steps", async () => {
    const { executor } = makeExecutor("done", { deferDoneToReview: false });
    executor.runImplementationPhase = vi.fn().mockResolvedValue({ taskDone: true, modifiedFiles: [] });

    const result = await executor.runGraphTaskStep(task, 0, "inst-0");

    /*
     * FNXC:WorkflowStepSessions 2026-06-30-00:00:
     * Default Coding has no per-step review, so it must let `runStepsInNewSessions` control session reuse. The graph driver should not pin StepSessionExecutor for this shape.
     */
    expect(result.success).toBe(true);
    expect(executor.graphStepSessionPinned.has("FN-001")).toBe(false);
  });

  it("forces step-session mode when step-review owns done-marking", async () => {
    const { executor } = makeExecutor("in-progress", { deferDoneToReview: true });
    executor.runImplementationPhase = vi.fn().mockResolvedValue({ taskDone: false, modifiedFiles: [] });

    const result = await executor.runGraphTaskStep(task, 0, "inst-0");

    expect(result.success).toBe(true);
    expect(executor.graphStepSessionPinned.has("FN-001")).toBe(true);
  });

  // T9: a RETHINK after a SUCCESSFUL pass must clear the memoized implementation
  // so the rework re-runs implementation rather than re-awaiting the resolved memo.
  it("clears the memo on rethink reset so implementation re-runs after a successful pass", async () => {
    const { executor, store } = makeExecutor("done", { deferDoneToReview: true });
    // No-op the git/step reset machinery — only the memo-clearing path matters here.
    store.getTask = vi.fn().mockResolvedValue({ id: "FN-001", steps: [{ name: "S1", status: "done" }] });
    let calls = 0;
    executor.runImplementationPhase = vi.fn().mockImplementation(async () => {
      calls += 1;
      return { taskDone: true, modifiedFiles: [] };
    });

    // First pass: succeeds and the memo is now resolved.
    const first = await executor.runGraphTaskStep(task, 0, "inst-0");
    expect(first.success).toBe(true);
    expect(calls).toBe(1);
    expect(executor.graphStepRunOnce.has("FN-001")).toBe(true);

    // RETHINK reset clears the SETTLED memo (guarded against in-flight clobber).
    await executor.applyGraphRethinkReset("FN-001", { stepIndex: 0, instanceId: "inst-0" });
    expect(executor.graphStepRunOnce.has("FN-001")).toBe(false);

    // Rework re-run: implementation is invoked AGAIN (the bug re-awaited the memo).
    const second = await executor.runGraphTaskStep(task, 0, "inst-0");
    expect(second.success).toBe(true);
    expect(calls).toBe(2);
  });

  // T7: parallel instances of the same task keep independent active contexts.
  it("keys active context per-instance so parallel foreach instances do not clobber", async () => {
    const store = createMockStore();
    store.getTask = vi.fn().mockResolvedValue({ id: "FN-001", steps: [{ name: "S1", status: "in-progress" }] });
    const executor: any = new TaskExecutor(store, "/tmp/test", {});
    // Instance A defers done to review (non-terminal → success); instance B does not
    // (non-terminal → failure). A per-task key would let one overwrite the other.
    executor.graphStepActiveContext.set(
      graphActiveContextKey("FN-001", "inst-A"),
      { stepIndex: 0, instanceId: "inst-A", deferDoneToReview: true },
    );
    executor.graphStepActiveContext.set(
      graphActiveContextKey("FN-001", "inst-B"),
      { stepIndex: 0, instanceId: "inst-B", deferDoneToReview: false },
    );
    executor.runImplementationPhase = vi.fn().mockResolvedValue({ taskDone: false, modifiedFiles: [] });

    const a = await executor.runGraphTaskStep(task, 0, "inst-A");
    const b = await executor.runGraphTaskStep(task, 0, "inst-B");
    expect(a.success).toBe(true); // review authors done
    expect(b.success).toBe(false); // implementation left it incomplete
  });
});

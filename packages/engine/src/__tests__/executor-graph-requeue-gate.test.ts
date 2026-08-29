import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

const now = "2026-06-23T00:00:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-GRAPH-REQUEUE",
    title: "Graph execute recovery",
    description: "Gate coverage for execute-node self-requeue preservation",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-graph-requeue",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-graph-requeue",
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

describe("executor graph execute self-requeue gate", () => {
  it("preserves executor todo recovery when the live refetch is stale in-progress", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ column: "in-progress" });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
    });
    const executor = new TaskExecutor(store, "/tmp/test");

    /*
    FNXC:WorkflowLifecycle 2026-06-23-23:03:
    The workflow cutover gate must directly cover the graph execute self-requeue guard. A stale live `in-progress` refetch after an inner executor moved the task to `todo` must not be parked in review or marked failed.
    */
    (executor as any).graphRouting.add(live.id);
    (executor as any).markGraphExecuteSelfRequeued(live.id);
    try {
      await (executor as any).handleGraphFailure(live, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["execute"],
        context: { "node:execute:value": "recoverable" },
      });
    } finally {
      (executor as any).graphRouting.delete(live.id);
    }

    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("executor recovery preserved"),
      undefined,
      undefined,
    );
    expect(store.moveTask).not.toHaveBeenCalledWith(live.id, "in-review", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });

  it("moves in-review graph failures with incomplete steps back to todo for resume", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-7228",
      column: "in-review",
      status: "failed",
      error: "Workflow graph terminated with failure at node 'parse'",
      steps: [
        { name: "Preflight", status: "in-progress" },
        { name: "Implement", status: "in-progress" },
        { name: "Testing & Verification", status: "pending" },
      ],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    /*
     * FNXC:WorkflowLifecycle 2026-06-29-11:12:
     * FN-7228/FN-7229 proved that restart-time graph failures can surface after a
     * stale handoff put the card in `in-review` with unfinished steps. Review is
     * not an error bucket; bounce that shape back to `todo` preserving step
     * progress so the engine can resume the correct unfinished step.
     */
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["parse"],
      context: { "node:parse:value": "parse-error" },
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: null, error: null }),
      undefined,
    );
    expect(store.moveTask).toHaveBeenCalledWith(
      live.id,
      "todo",
      expect.objectContaining({ preserveProgress: true, moveSource: "engine", recoveryRehome: true }),
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("moves premature merge failures with incomplete in-progress steps back to todo", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-7261",
      column: "in-progress",
      status: null,
      error: null,
      steps: [
        { name: "Preflight", status: "in-progress" },
        { name: "Implement", status: "pending" },
      ],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    /*
     * FNXC:WorkflowMerge 2026-06-29-23:18:
     * Fast-mode graph traversal must not turn an unfinished legacy checklist into a no-op merge. If the merge node is reached before implementation proof exists, recover by requeueing executable work instead of parking the task failed in-progress.
     */
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["merge"],
      context: { "node:merge:value": "implementation-incomplete" },
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: null, error: null }),
      undefined,
    );
    expect(store.moveTask).toHaveBeenCalledWith(
      live.id,
      "todo",
      expect.objectContaining({ preserveProgress: true, moveSource: "engine", recoveryRehome: true }),
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });

  it("does not flag a remediation-node graph failure as failed while a live agent session is executing", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-REMEDIATION-LIVE",
      column: "in-progress",
      steps: [{ name: "Implement", status: "in-progress" }],
    });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
    });
    const executor = new TaskExecutor(store, "/tmp/test");

    /*
     * FNXC:WorkflowRemediation 2026-07-01-23:40:
     * `code-review-remediation` is a fire-and-forget async scheduler with no
     * `failure` out-edge; a failed re-arm bubbles out as the terminal graph
     * outcome. When a SEPARATE live agent session surface is still registered
     * (the previously-scheduled fix/reviewer is mid-flight), the terminal sink
     * must NOT stamp `status:"failed"` over live work.
     */
    (executor as any).activeSessions.set(live.id, { session: {} });
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["code-review", "code-review-remediation"],
      context: {},
    });

    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("not flagging as failed"),
      undefined,
      undefined,
    );
    expect(store.moveTask).not.toHaveBeenCalledWith(live.id, "in-review", expect.anything());
  });

  it("auto-recovers a no-live-session code-review-remediation failure with a durable failed gate result", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-7476-REMEDIATION",
      column: "in-review",
      status: "failed",
      error: "Workflow graph terminated with failure at node 'code-review-remediation'",
      steps: [{ name: "Implement", status: "done" }],
      postReviewFixCount: 99,
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        output: "Fix the reviewer finding before merge.",
        startedAt: now,
        completedAt: now,
      }],
      log: Array.from({ length: 99 }, (_, index) => ({
        timestamp: now,
        action: `Auto-reviving in-review task with failed pre-merge workflow step (attempt ${index + 1}/unbounded)`,
        outcome: "Step: Code Review\nWorkflow revision key: code-review",
      })),
    });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
    });
    const executor = new TaskExecutor(store, "/tmp/test");

    /*
     * FNXC:WorkflowRemediation 2026-07-03-20:10:
     * FN-7476-class parked rows have no live session left, but the durable failed
     * Code Review result is enough evidence to reuse the remediation handoff.
     * Built-in Code Review remains unbounded by default, so high prior attempt
     * counts must not force manual retry unless a numeric cap was configured.
     */
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["code-review", "code-review-remediation"],
      context: { "node:code-review-remediation:value": "remediation-not-scheduled" },
    });

    expect(store.updateTask).toHaveBeenCalledWith(live.id, { postReviewFixCount: 100 }, undefined);
    expect(store.addTaskComment).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("Auto-revived from in-review: pre-merge workflow step \"Code Review\" had failed"),
      "agent",
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("Auto-recovered retryable remediation node 'code-review-remediation'"),
      expect.stringContaining("Workflow revision key: code-review"),
      undefined,
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("does not route plan-replan graph failures through pre-merge remediation recovery", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-PLAN-REPLAN-PARKED",
      column: "in-review",
      status: "failed",
      error: "Workflow graph terminated with failure at node 'plan-replan'",
      steps: [{ name: "Plan", status: "done" }],
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        status: "failed",
        output: "Revise the task plan before implementation.",
        startedAt: now,
        completedAt: now,
      }],
    });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
    });
    const executor = new TaskExecutor(store, "/tmp/test");

    /*
     * FNXC:WorkflowRemediation 2026-07-03-23:10:
     * A parked Plan Review `plan-replan` failure is not a pre-merge implementation remediation node. It must not call the Code Review remediation bridge, because that bridge injects fix instructions and sends the task back to executor work instead of the plan-replan/triage path.
     */
    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["plan-review", "plan-replan"],
      context: { "node:plan-replan:value": "remediation-not-scheduled" },
    });

    expect(store.addTaskComment).not.toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("Auto-revived from in-review: pre-merge workflow step"),
      "agent",
    );
    expect(store.logEntry).not.toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("Auto-recovered retryable remediation node 'plan-replan'"),
      expect.anything(),
      expect.anything(),
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(live.id, { status: null, error: null }, undefined);
    expect(store.updateTask).not.toHaveBeenCalledWith(live.id, { workflowStepResults: [] }, undefined);
  });

  it.each(["remediation-not-scheduled", "missing-remediation-context"])("FN-8910 keeps a completed review card in place when remediation reports %s", async (failureValue) => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: `FN-8910-${failureValue}`,
      column: "in-review",
      steps: [{ name: "Implement", status: "done" }],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    await expect((executor as any).routeGraphFailureToExecutionResume(
      live,
      "code-review-remediation",
      failureValue,
    )).resolves.toBe(false);

    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["code-review", "code-review-remediation"],
      context: { "node:code-review-remediation:value": failureValue },
    });

    /*
    FNXC:WorkflowRemediation 2026-08-09-21:53:
    FN-8910 requires policy-refused remediation to remain visibly parked in the
    review lane after implementation is complete, never rebound to execution.
    */
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("still resumes an incomplete review card after a refused remediation", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-8910-INCOMPLETE",
      column: "in-review",
      steps: [{ name: "Implement", status: "pending" }],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    await expect((executor as any).routeGraphFailureToExecutionResume(
      live,
      "code-review-remediation",
      "remediation-not-scheduled",
    )).resolves.toBe(true);

    expect(store.moveTask).toHaveBeenCalledWith(
      live.id,
      "todo",
      expect.objectContaining({ preserveProgress: true, recoveryRehome: true }),
    );
  });

  it("still parks a remediation-node graph failure as failed when no durable failed gate result exists", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-REMEDIATION-DEAD",
      column: "in-progress",
      steps: [{ name: "Implement", status: "in-progress" }],
    });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
    });
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["code-review", "code-review-remediation"],
      context: {},
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("Workflow graph terminated with failure at node 'code-review-remediation'"),
      }),
      undefined,
    );
  });

  it("does not hand generic graph failures to review", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({
      id: "FN-7229",
      column: "in-progress",
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "in-progress" },
      ],
    });
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["parse"],
      context: { "node:parse:value": "parse-error" },
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("Workflow graph terminated with failure at node 'parse'"),
      }),
      undefined,
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalledWith(live.id, "in-review", expect.anything());
  });
});

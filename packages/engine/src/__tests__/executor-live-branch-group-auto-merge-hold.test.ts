import { describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore } from "./executor-test-helpers.js";
import type { TaskDetail } from "@fusion/core";

const now = "2026-07-09T17:18:00.000Z";

function makeInReviewTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-1980",
    title: "engine-created stale branch-group member",
    description: "Reproduces Runfusion/Fusion#1980 stale branch-group auto-merge-off bypass",
    column: "in-review",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-1980",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-1980",
    status: "reviewing",
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: undefined,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    branchContext: { assignmentMode: "shared", groupId: "BG-STALE", source: "mission" },
    sourceType: "unknown",
    sourceMetadata: {
      fusionBranchContext: { assignmentMode: "shared", groupId: "BG-STALE", source: "mission" },
    },
    ...overrides,
  } as TaskDetail;
}

function makeExecutor(
  branchGroup: { status: "open" | "finalized" | "abandoned"; branchName: string } | null,
  autoMerge = false,
) {
  const store = createMockStore();
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
    autoMerge,
    maxAutoMergeRetries: 3,
  });
  store.getBranchGroup = vi.fn(() => branchGroup);
  const executor = new TaskExecutor(store, "/tmp/test", {});
  return { executor, store };
}

const mergeAbortResult = {
  visitedNodeIds: ["merge"],
  context: { "node:merge:value": "aborted" },
};

const interruptedExecuteResult = {
  interruptedAbortKind: "engine-pause",
  interruptedNodeId: "execute",
  visitedNodeIds: ["execute"],
  context: {},
};

describe("executor shared-branch autoMerge:false liveness gates", () => {
  it("does not route an engine-created dissolved-group member to auto-merge retry", async () => {
    const { executor, store } = makeExecutor(null);
    const task = makeInReviewTask();

    const retryable = await (executor as any).isRetryableBenignMergePauseAbort(
      task,
      mergeAbortResult,
      "merge-seam",
      true,
    );

    expect(retryable).toBe(false);
    expect(store.getBranchGroup).not.toHaveBeenCalled();
  });

  it("holds a live shared-group member when an operator explicitly turns auto-merge off", async () => {
    const { executor } = makeExecutor({ status: "open", branchName: "mission/M-1980" });
    const task = makeInReviewTask({ autoMerge: false, autoMergeProvenance: "user" });

    await expect((executor as any).isRetryableBenignMergePauseAbort(
      task,
      mergeAbortResult,
      "merge-seam",
      true,
    )).resolves.toBe(false);
  });

  it.each(["mission", "legacy-stamp", undefined] as const)("keeps live shared-group policy or legacy false values flowing when project On (%s)", async (autoMergeProvenance) => {
    const { executor } = makeExecutor({ status: "open", branchName: "mission/M-1980" }, true);
    const task = makeInReviewTask({ autoMerge: false, autoMergeProvenance });

    await expect((executor as any).isRetryableBenignMergePauseAbort(
      task,
      mergeAbortResult,
      "merge-seam",
      true,
    )).resolves.toBe(true);
  });

  it("still routes live shared-group members through the local integration retry gate when project On", async () => {
    const { executor } = makeExecutor({ status: "open", branchName: "mission/M-1980" }, true);
    const task = makeInReviewTask();

    await expect((executor as any).isRetryableBenignMergePauseAbort(
      task,
      mergeAbortResult,
      "merge-seam",
      true,
    )).resolves.toBe(true);
  });

  it("re-enters an interrupted mission-policy member rather than stranding its local integration when project On", async () => {
    const { executor } = makeExecutor({ status: "open", branchName: "mission/M-1980" }, true);
    const task = makeInReviewTask({
      autoMerge: false,
      autoMergeProvenance: "mission",
      status: null,
      error: null,
    });

    await expect((executor as any).isReentrantPausedAbortedInFlightNode(
      task,
      interruptedExecuteResult,
      "engine-abort",
      true,
      false,
    )).resolves.toBe(true);
  });

  it("FN-8910 reopens an unset project-Off shared member at live and failed-step remediation seams", async () => {
    const { executor, store } = makeExecutor({ status: "open", branchName: "mission/M-1980" });
    const task = makeInReviewTask({
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        output: "Please revise",
      }],
    });
    store.getTask.mockResolvedValue(task);
    const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix");

    await expect((executor as any).requestPreMergeOptionalStepFix(task.id, task, {
      stepName: "Code Review",
      feedback: "Please revise",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      nodeId: "code-review",
    })).resolves.toBe(true);
    await expect(executor.recoverFailedPreMergeWorkflowStep(task)).resolves.toBe(true);

    expect(sendBack).toHaveBeenCalledTimes(2);
  });

  it("FN-8910 replans Plan Review for an unset project-Off shared member", async () => {
    const { executor, store } = makeExecutor({ status: "open", branchName: "mission/M-1980" });
    const task = makeInReviewTask({ column: "in-progress", status: null });
    store.getTask.mockResolvedValue(task);

    await expect((executor as any).requestPreMergeOptionalStepFix(task.id, task, {
      stepName: "Plan Review",
      feedback: "Revise the task specification.",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      nodeId: "plan-review",
    })).resolves.toBe(true);

    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo", { preserveWorktree: true });
    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "needs-replan" }), undefined);
  });

  it("FN-8910 routes retryable remediation failure through the reopened shared-member seam", async () => {
    const { executor, store } = makeExecutor({ status: "open", branchName: "mission/M-1980" });
    const task = makeInReviewTask({
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        output: "Please revise",
      }],
    });
    store.getTask.mockResolvedValue(task);
    const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

    await expect((executor as any).routeRetryableRemediationGraphFailureToPreMergeFix(
      task,
      "code-review-remediation",
      "remediation-not-scheduled",
    )).resolves.toBe(true);

    expect(sendBack).toHaveBeenCalledOnce();
  });

  it("does not let live pre-merge remediation reopen an operator-held member", async () => {
    const { executor, store } = makeExecutor({ status: "open", branchName: "mission/M-1980" });
    const task = makeInReviewTask({ autoMerge: false, autoMergeProvenance: "user" });
    store.getTask.mockResolvedValue(task);
    const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix");

    await expect((executor as any).requestPreMergeOptionalStepFix(task.id, task, {
      stepName: "Code Review",
      feedback: "Please revise",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      nodeId: "code-review",
    })).resolves.toBe(false);

    expect(sendBack).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("operator task hold"),
      expect.stringContaining("operator-authored task-level auto-merge Off"),
      undefined,
    );
  });

  it("does not let failed-step recovery reopen an operator-held member", async () => {
    const { executor, store } = makeExecutor({ status: "open", branchName: "mission/M-1980" });
    const task = makeInReviewTask({
      autoMerge: false,
      autoMergeProvenance: "user",
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        output: "Please revise",
      }],
    });
    const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix");

    await expect(executor.recoverFailedPreMergeWorkflowStep(task)).resolves.toBe(false);

    expect(sendBack).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("operator task hold"),
      expect.stringContaining("operator-authored task-level auto-merge Off"),
      undefined,
    );
  });

  it("holds an open shared group that would integrate directly into main", async () => {
    const { executor } = makeExecutor({ status: "open", branchName: "main" });
    const task = makeInReviewTask();

    await expect((executor as any).isRetryableBenignMergePauseAbort(
      task,
      mergeAbortResult,
      "merge-seam",
      true,
    )).resolves.toBe(false);
  });
});

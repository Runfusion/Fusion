import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import { assertResetTask, buildResetTask } from "../task-store/reset-lifecycle.js";

const now = "2026-08-28T20:50:00.000Z";

function populatedTask(): Task {
  return {
    id: "FN-239",
    title: "Reset a task",
    description: "Keep the original request",
    column: "in-review",
    status: "merging-fix",
    dependencies: [],
    steps: [{ title: "Discarded plan", description: "Old work", status: "done" }],
    currentStep: 1,
    log: [{ timestamp: now, message: "Operator-visible history" }],
    comments: [{ id: "comment-1", content: "Keep comment", createdAt: now }],
    steeringComments: [{ id: "steer-1", content: "Keep steering", createdAt: now }],
    attachments: [{ id: "attachment-1", name: "brief.txt", path: "attachments/brief.txt" }],
    assignedAgentId: "agent-239",
    modelPresetId: "preset-239",
    modelProvider: "anthropic",
    modelId: "model-239",
    validatorModelProvider: "openai",
    validatorModelId: "reviewer-239",
    planningModelProvider: "google",
    planningModelId: "planner-239",
    enabledWorkflowSteps: ["plan-review", "code-review"],
    reviewLevel: 2,
    noCommitsExpected: true,
    repositoryScope: { state: "confirmed", revision: 3, repositories: ["."] },
    branchContext: { assignmentMode: "shared", groupId: "group-239", integrationBranch: "fusion/group-239" },
    checkoutLeaseEpoch: 8,
    wedgeNotification: { reason: "terminal", episodeId: "episode-239", notifiedAt: now },
    recommendations: [{ id: "keep-recommendation", title: "Keep", description: "Historical recommendation", category: "other" }],
    firstExecutionAt: now,
    cumulativeActiveMs: 1_200,
    cumulativePlanningMs: 600,
    columnDwellMs: { "in-review": 300 },
    worktree: "/tmp/fn-239",
    workspaceWorktrees: { api: { worktreePath: "/tmp/fn-239/api", branch: "fusion/fn-239" } },
    branch: "fusion/fn-239",
    sessionFile: "/tmp/fn-239/session.json",
    workflowStepResults: [{ workflowStepId: "code-review", status: "failed" }],
    size: "M",
    prInfo: { number: 239, url: "https://example.invalid/pull/239", state: "open" },
    prInfos: [{ number: 239, url: "https://example.invalid/pull/239", state: "open" }],
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 20,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      firstUsedAt: now,
      lastUsedAt: now,
      byModel: {},
    },
    tokenBudgetSoftAlertedAt: now,
    tokenBudgetHardAlertedAt: now,
    stepReports: [{ stepIndex: 0, summary: "Discarded report", filesChanged: [] }],
    workflowTransitionNotification: { transitionId: "transition-239", toColumn: "in-review", createdAt: now },
    createdAt: now,
    updatedAt: now,
  } as unknown as Task;
}

function expectClearedShape(task: Task): void {
  expect(task.status).toBeUndefined();
  expect(task.steps).toEqual([]);
  expect(task.currentStep).toBe(0);
  expect(task.size).toBeUndefined();
  expect(task.prInfo).toBeUndefined();
  expect(task.prInfos).toBeUndefined();
  expect(task.tokenUsage).toBeUndefined();
  expect(task.tokenBudgetSoftAlertedAt).toBeUndefined();
  expect(task.tokenBudgetHardAlertedAt).toBeUndefined();
  expect(task.stepReports).toEqual([]);
  expect(task.workflowTransitionNotification).toBeUndefined();
}

describe("buildResetTask", () => {
  it("publishes a fresh planning shape while preserving operator intent and analytics", () => {
    const original = populatedTask();
    const reset = buildResetTask(original, "todo");

    expect(reset.column).toBe("todo");
    expectClearedShape(reset);
    expect(reset).toEqual(expect.objectContaining({
      log: original.log,
      comments: original.comments,
      steeringComments: original.steeringComments,
      attachments: original.attachments,
      assignedAgentId: original.assignedAgentId,
      modelPresetId: original.modelPresetId,
      modelProvider: original.modelProvider,
      modelId: original.modelId,
      validatorModelProvider: original.validatorModelProvider,
      validatorModelId: original.validatorModelId,
      planningModelProvider: original.planningModelProvider,
      planningModelId: original.planningModelId,
      enabledWorkflowSteps: original.enabledWorkflowSteps,
      reviewLevel: original.reviewLevel,
      noCommitsExpected: original.noCommitsExpected,
      repositoryScope: original.repositoryScope,
      branchContext: original.branchContext,
      checkoutLeaseEpoch: original.checkoutLeaseEpoch,
      wedgeNotification: original.wedgeNotification,
      recommendations: original.recommendations,
      firstExecutionAt: original.firstExecutionAt,
      cumulativeActiveMs: original.cumulativeActiveMs,
      cumulativePlanningMs: original.cumulativePlanningMs,
      columnDwellMs: original.columnDwellMs,
    }));
    expect(() => assertResetTask(reset, "todo", original.description)).not.toThrow();
  });

  it("resets an already-empty task without throwing", () => {
    const original = populatedTask();
    const empty = {
      ...original,
      status: undefined,
      steps: [],
      size: undefined,
      prInfo: undefined,
      prInfos: undefined,
      tokenUsage: undefined,
      tokenBudgetSoftAlertedAt: undefined,
      tokenBudgetHardAlertedAt: undefined,
      stepReports: undefined,
      workflowTransitionNotification: undefined,
    };

    const reset = buildResetTask(empty, "todo");
    expectClearedShape(reset);
    expect(() => assertResetTask(reset, "todo", original.description)).not.toThrow();
  });
});

describe("assertResetTask", () => {
  it("rejects a retained plan step", () => {
    const reset = buildResetTask(populatedTask(), "todo");
    expect(() => assertResetTask({ ...reset, steps: populatedTask().steps }, "todo", reset.description))
      .toThrow("retained plan steps");
  });

  it("rejects any non-undefined status", () => {
    const reset = buildResetTask(populatedTask(), "todo");
    expect(() => assertResetTask({ ...reset, status: null as unknown as string }, "todo", reset.description))
      .toThrow("outside its resolved fresh-planning state");
  });
});

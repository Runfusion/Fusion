/**
 * FNXC:PlannerOversight 2026-07-21-22:56:
 * Unit coverage for FN-8471 prevention helpers: live-session detection used by
 * overseer retry_step, and execute-family failure park that must not stamp
 * status=failed over a peer live session.
 */
import { describe, expect, it } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import type { TaskDetail } from "@fusion/core";

const now = "2026-07-21T22:56:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-LIVE",
    title: "Live session gate",
    description: "coverage",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "in-progress" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-live",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-live",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

describe("isTaskLiveForOverseerRetry", () => {
  it("is false when no sessions or execution claims exist", () => {
    resetExecutorMocks();
    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    expect(executor.isTaskLiveForOverseerRetry("FN-1")).toBe(false);
  });

  it("is true when a coding session surface is registered", () => {
    resetExecutorMocks();
    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    (executor as any).activeSessions.set("FN-1", { id: "s1" });
    expect(executor.isTaskLiveForOverseerRetry("FN-1")).toBe(true);
  });

  it("is true when step/CLI session surfaces are registered", () => {
    resetExecutorMocks();
    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    (executor as any).activeStepExecutors.set("FN-2", {});
    expect(executor.isTaskLiveForOverseerRetry("FN-2")).toBe(true);
    (executor as any).activeStepExecutors.delete("FN-2");
    (executor as any).activeCliTaskSessions.set("FN-3", {});
    expect(executor.isTaskLiveForOverseerRetry("FN-3")).toBe(true);
  });

  it("is true for resumingUnpaused and executing-only membership", () => {
    resetExecutorMocks();
    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    (executor as any).resumingUnpaused.add("FN-4");
    expect(executor.isTaskLiveForOverseerRetry("FN-4")).toBe(true);
    (executor as any).resumingUnpaused.delete("FN-4");
    (executor as any).executing.add("FN-5");
    expect(executor.isTaskLiveForOverseerRetry("FN-5")).toBe(true);
  });
});

describe("handleGraphFailure execute-family live session preserve", () => {
  it("does not park status=failed for step-execute when a peer live session exists", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ column: "in-progress", status: null });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      executorToolFailureRetryCount: 0,
    });
    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any).activeSessions.set(live.id, { id: "peer-session" });
    (executor as any).graphRouting.add(live.id);
    try {
      await (executor as any).handleGraphFailure(live, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["steps#1:step-execute"],
        context: { "node:steps#1:step-execute:value": "step-failed" },
      });
    } finally {
      (executor as any).graphRouting.delete(live.id);
      (executor as any).activeSessions.delete(live.id);
    }

    expect(store.logEntry).toHaveBeenCalledWith(
      live.id,
      expect.stringContaining("while a live agent session is still executing"),
      undefined,
      undefined,
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });

  it("still parks status=failed for merge-region failure even when a live session exists", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ column: "in-progress", status: null });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue({
      autoMerge: true,
      maxAutoMergeRetries: 3,
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      executorToolFailureRetryCount: 0,
    });
    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any).activeSessions.set(live.id, { id: "peer-session" });
    (executor as any).graphRouting.add(live.id);
    try {
      await (executor as any).handleGraphFailure(live, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["merge-attempt"],
        context: { "node:merge-attempt:value": "merge-failed" },
      });
    } finally {
      (executor as any).graphRouting.delete(live.id);
      (executor as any).activeSessions.delete(live.id);
    }

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed", error: expect.stringContaining("merge-attempt") }),
      undefined,
    );
  });
});

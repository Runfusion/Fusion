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

function makeExecutor(branchGroup: { status: "open" | "finalized" | "abandoned" } | null) {
  const store = createMockStore();
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
    autoMerge: false,
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
    expect(store.getBranchGroup).toHaveBeenCalledWith("BG-STALE");
  });

  it("still routes live shared-group members through the local integration retry gate", async () => {
    const { executor } = makeExecutor({ status: "open" });
    const task = makeInReviewTask();

    await expect((executor as any).isRetryableBenignMergePauseAbort(
      task,
      mergeAbortResult,
      "merge-seam",
      true,
    )).resolves.toBe(true);
  });
});

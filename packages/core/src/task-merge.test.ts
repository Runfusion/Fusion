import { describe, it, expect } from "vitest";
import type { StepStatus } from "./types.js";
import { getTaskMergeBlocker, isTaskReadyForMerge } from "./task-merge.js";

const baseTask = {
  column: "in-review" as const,
  paused: false,
  status: undefined as string | undefined,
  error: undefined as string | undefined,
  steps: [] as Array<{ name: string; status: StepStatus }>,
  workflowStepResults: undefined as any,
};

describe("getTaskMergeBlocker", () => {
  it("returns undefined for a clean task in review", () => {
    expect(getTaskMergeBlocker(baseTask)).toBeUndefined();
  });

  it("returns reason when task is not in review", () => {
    expect(getTaskMergeBlocker({ ...baseTask, column: "todo" }))
      .toContain("must be in 'in-review'");
  });

  it("returns reason when task is paused", () => {
    expect(getTaskMergeBlocker({ ...baseTask, paused: true }))
      .toBe("task is paused");
  });

  it("returns reason when task has failed status", () => {
    expect(getTaskMergeBlocker({ ...baseTask, status: "failed" }))
      .toContain("failed");
  });

  it("returns reason when task has incomplete steps", () => {
    expect(getTaskMergeBlocker({
      ...baseTask,
      steps: [{ name: "Step 1", status: "in-progress" }],
    })).toBe("task has incomplete steps");
  });

  // ── Workflow Step Phase Awareness ──────────────────────────────────────

  it("blocks merge when pre-merge workflow step has failed", () => {
    const result = getTaskMergeBlocker({
      ...baseTask,
      workflowStepResults: [{
        workflowStepId: "WS-001",
        workflowStepName: "Pre-merge Check",
        phase: "pre-merge",
        status: "failed",
        output: "Check failed",
      }],
    });
    expect(result).toContain("pre-merge workflow steps");
  });

  it("blocks merge when legacy workflow step (no phase) has failed", () => {
    const result = getTaskMergeBlocker({
      ...baseTask,
      workflowStepResults: [{
        workflowStepId: "WS-001",
        workflowStepName: "Legacy Check",
        // phase is undefined → treated as pre-merge
        status: "failed",
        output: "Check failed",
      }],
    });
    expect(result).toContain("pre-merge workflow steps");
  });

  it("does NOT block merge when only post-merge workflow step has failed", () => {
    const result = getTaskMergeBlocker({
      ...baseTask,
      workflowStepResults: [{
        workflowStepId: "WS-001",
        workflowStepName: "Post-merge Notify",
        phase: "post-merge",
        status: "failed",
        output: "Notification failed",
      }],
    });
    expect(result).toBeUndefined();
  });

  it("does NOT block merge when pre-merge passed and post-merge failed", () => {
    const result = getTaskMergeBlocker({
      ...baseTask,
      workflowStepResults: [
        {
          workflowStepId: "WS-001",
          workflowStepName: "Pre-merge Check",
          phase: "pre-merge",
          status: "passed",
        },
        {
          workflowStepId: "WS-002",
          workflowStepName: "Post-merge Notify",
          phase: "post-merge",
          status: "failed",
          output: "Failed",
        },
      ],
    });
    expect(result).toBeUndefined();
  });

  it("blocks merge when pre-merge step is still pending", () => {
    const result = getTaskMergeBlocker({
      ...baseTask,
      workflowStepResults: [{
        workflowStepId: "WS-001",
        workflowStepName: "Pre-merge Check",
        phase: "pre-merge",
        status: "pending",
      }],
    });
    expect(result).toContain("pre-merge workflow steps");
  });

  it("does NOT block merge when only post-merge step is pending", () => {
    const result = getTaskMergeBlocker({
      ...baseTask,
      workflowStepResults: [{
        workflowStepId: "WS-001",
        workflowStepName: "Post-merge Notify",
        phase: "post-merge",
        status: "pending",
      }],
    });
    expect(result).toBeUndefined();
  });

  it("allows merge when all pre-merge steps passed regardless of post-merge status", () => {
    const result = getTaskMergeBlocker({
      ...baseTask,
      workflowStepResults: [
        {
          workflowStepId: "WS-001",
          workflowStepName: "Pre-merge Check",
          phase: "pre-merge",
          status: "passed",
        },
        {
          workflowStepId: "WS-002",
          workflowStepName: "Post-merge Verify",
          phase: "post-merge",
          status: "skipped",
        },
      ],
    });
    expect(result).toBeUndefined();
  });
});

describe("isTaskReadyForMerge", () => {
  it("returns true for a clean task in review", () => {
    expect(isTaskReadyForMerge(baseTask)).toBe(true);
  });

  it("returns false when pre-merge step failed", () => {
    expect(isTaskReadyForMerge({
      ...baseTask,
      workflowStepResults: [{
        workflowStepId: "WS-001",
        workflowStepName: "Check",
        phase: "pre-merge",
        status: "failed",
      }],
    })).toBe(false);
  });

  it("returns true when only post-merge step failed", () => {
    expect(isTaskReadyForMerge({
      ...baseTask,
      workflowStepResults: [{
        workflowStepId: "WS-001",
        workflowStepName: "Notify",
        phase: "post-merge",
        status: "failed",
      }],
    })).toBe(true);
  });
});

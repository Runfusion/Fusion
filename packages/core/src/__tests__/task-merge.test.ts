import { describe, it, expect } from "vitest";
import type { StepStatus } from "../types.js";
import { getTaskCompletionBlocker, getTaskMergeBlocker, isTaskReadyForMerge } from "../task-merge.js";

const baseTask = {
  column: "in-review" as const,
  paused: false,
  status: undefined as string | undefined,
  error: undefined as string | undefined,
  steps: [] as Array<{ name: string; status: StepStatus }>,
  workflowStepResults: undefined as any,
};

const baseCompletionTask = {
  dependencies: [] as string[],
  blockedBy: undefined as string | undefined,
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

  it("returns reason when task has awaiting-user-review status", () => {
    expect(getTaskMergeBlocker({ ...baseTask, status: "awaiting-user-review" }))
      .toContain("awaiting-user-review");
  });

  it("returns reason when task has awaiting-inspection status", () => {
    expect(getTaskMergeBlocker({ ...baseTask, status: "awaiting-inspection" }))
      .toContain("awaiting-inspection");
  });

  it("returns reason when task has planning status", () => {
    // Planning means the user moved the task back to triage/specification —
    // its scope isn't finalized, so merging the in-flight branch is wrong.
    expect(getTaskMergeBlocker({ ...baseTask, status: "planning" }))
      .toContain("planning");
  });

  it("returns reason when task has the legacy 'specifying' status", () => {
    // Legacy alias migrated to "planning" in db.ts; guard against any
    // un-migrated rows that might still surface this value.
    expect(getTaskMergeBlocker({ ...baseTask, status: "specifying" }))
      .toContain("specifying");
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

describe("getTaskCompletionBlocker", () => {
  it("returns undefined for a task with no blockers", async () => {
    await expect(getTaskCompletionBlocker(baseCompletionTask)).resolves.toBeUndefined();
  });

  it("returns a reason when task has blockedBy", async () => {
    await expect(getTaskCompletionBlocker({ ...baseCompletionTask, blockedBy: "FN-123" }))
      .resolves.toBe("task is blocked by FN-123");
  });

  it("returns a reason when a dependency is unresolved", async () => {
    const resolveTask = async (taskId: string) => {
      if (taskId === "FN-001") {
        return { id: "FN-001", column: "done" as const };
      }
      if (taskId === "FN-002") {
        return { id: "FN-002", column: "in-progress" as const };
      }
      return null;
    };

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      dependencies: ["FN-001", "FN-002"],
    }, { resolveTask }))
      .resolves.toBe("task has unresolved dependencies: FN-002");
  });

  it("returns undefined when all dependencies are resolved", async () => {
    const resolveTask = async (taskId: string) => ({ id: taskId, column: "done" as const });

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      dependencies: ["FN-001", "FN-002"],
    }, { resolveTask }))
      .resolves.toBeUndefined();
  });

  // ── in-review as resolved dependency ───────────────────────────────────

  it("returns undefined when a dependency is in-review", async () => {
    const resolveTask = async (taskId: string) => {
      if (taskId === "FN-001") {
        return { id: "FN-001", column: "in-review" as const };
      }
      return null;
    };

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      dependencies: ["FN-001"],
    }, { resolveTask }))
      .resolves.toBeUndefined();
  });

  it("returns undefined when dependencies are a mix of done and in-review", async () => {
    const resolveTask = async (taskId: string) => {
      if (taskId === "FN-001") {
        return { id: "FN-001", column: "done" as const };
      }
      if (taskId === "FN-002") {
        return { id: "FN-002", column: "in-review" as const };
      }
      return null;
    };

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      dependencies: ["FN-001", "FN-002"],
    }, { resolveTask }))
      .resolves.toBeUndefined();
  });

  it("returns a reason when a dependency is in-progress", async () => {
    const resolveTask = async (taskId: string) => {
      if (taskId === "FN-001") {
        return { id: "FN-001", column: "in-progress" as const };
      }
      return null;
    };

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      dependencies: ["FN-001"],
    }, { resolveTask }))
      .resolves.toBe("task has unresolved dependencies: FN-001");
  });

  it("returns a reason when a dependency is in triage", async () => {
    const resolveTask = async (taskId: string) => {
      if (taskId === "FN-001") {
        return { id: "FN-001", column: "triage" as const };
      }
      return null;
    };

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      dependencies: ["FN-001"],
    }, { resolveTask }))
      .resolves.toBe("task has unresolved dependencies: FN-001");
  });

  it("returns a reason when a dependency is in todo", async () => {
    const resolveTask = async (taskId: string) => {
      if (taskId === "FN-001") {
        return { id: "FN-001", column: "todo" as const };
      }
      return null;
    };

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      dependencies: ["FN-001"],
    }, { resolveTask }))
      .resolves.toBe("task has unresolved dependencies: FN-001");
  });

  it("returns a reason when a dependency task does not exist", async () => {
    const resolveTask = async (_taskId: string) => null;

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      dependencies: ["FN-999"],
    }, { resolveTask }))
      .resolves.toBe("task has unresolved dependencies: FN-999");
  });
});

import { describe, it, expect } from "vitest";
import type { StepStatus } from "../types.js";
import {
  BLOCKING_TASK_STATUSES,
  HARD_BLOCKING_TASK_STATUSES,
  SCHEDULER_TRANSIENT_STATUSES,
  getTaskCompletionBlocker,
  getTaskHardMergeBlocker,
  getTaskMergeBlocker,
  isTaskReadyForMerge,
  resolveTaskMergeTarget,
} from "../task-merge.js";

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

describe("resolveTaskMergeTarget", () => {
  it("prefers task baseBranch when present", () => {
    expect(resolveTaskMergeTarget({ baseBranch: "release/1.2", branchContext: undefined })).toEqual({
      branch: "release/1.2",
      source: "task-base-branch",
    });
  });

  it("falls back to inherited branch context", () => {
    expect(resolveTaskMergeTarget({
      baseBranch: undefined,
      branchContext: {
        groupId: "G-1",
        source: "planning",
        assignmentMode: "shared",
        inheritedBaseBranch: "develop",
      },
    })).toEqual({
      branch: "develop",
      source: "task-branch-context",
    });
  });

  it("trims inherited branch context before using it", () => {
    expect(resolveTaskMergeTarget({
      baseBranch: undefined,
      branchContext: {
        groupId: "G-1",
        source: "planning",
        assignmentMode: "shared",
        inheritedBaseBranch: "  release/2026.10  ",
      },
    })).toEqual({
      branch: "release/2026.10",
      source: "task-branch-context",
    });
  });

  it("uses project default branch when task has no explicit target", () => {
    expect(resolveTaskMergeTarget(
      { baseBranch: undefined, branchContext: undefined },
      { projectDefaultBranch: "trunk" },
    )).toEqual({
      branch: "trunk",
      source: "project-default",
    });
  });

  it("falls back to legacy main when no target is configured", () => {
    expect(resolveTaskMergeTarget({ baseBranch: undefined, branchContext: undefined })).toEqual({
      branch: "main",
      source: "legacy-main",
    });
  });

  // Regression for FN-5233/FN-5530: when a sibling-dispatched task inherits
  // `baseBranch = fusion/fn-<id>`, the merger must NOT use that as the squash
  // destination — otherwise the commit lands on the sibling branch and is
  // lost from main. Falls through to projectDefault, and reports the rejection.
  it("rejects task baseBranch when it points at a sibling fusion/fn-* branch", () => {
    const result = resolveTaskMergeTarget(
      { baseBranch: "fusion/fn-5339", branchContext: undefined },
      { projectDefaultBranch: "main" },
    );
    expect(result.branch).toBe("main");
    expect(result.source).toBe("project-default");
    expect(result.rejected).toEqual({
      branch: "fusion/fn-5339",
      source: "task-base-branch",
      reason: "fusion-sibling-branch",
    });
  });

  it("rejects inherited branch context that points at a sibling fusion/fn-* branch", () => {
    const result = resolveTaskMergeTarget(
      {
        baseBranch: undefined,
        branchContext: {
          groupId: "G-1",
          source: "planning",
          assignmentMode: "shared",
          inheritedBaseBranch: "FUSION/FN-1234",
        },
      },
      { projectDefaultBranch: "main" },
    );
    expect(result.branch).toBe("main");
    expect(result.source).toBe("project-default");
    expect(result.rejected).toEqual({
      branch: "FUSION/FN-1234",
      source: "task-branch-context",
      reason: "fusion-sibling-branch",
    });
  });

  it("does not reject non-fusion branches that happen to share a prefix", () => {
    // `fusion/release-1.0` is a legitimate human-chosen base; only the
    // canonical `fusion/fn-<id>` pattern is a sibling-task marker.
    expect(resolveTaskMergeTarget({ baseBranch: "fusion/release-1.0", branchContext: undefined })).toEqual({
      branch: "fusion/release-1.0",
      source: "task-base-branch",
    });
  });
});

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

  it("returns reason when task is awaiting-approval", () => {
    expect(getTaskMergeBlocker({ ...baseTask, status: "awaiting-approval" }))
      .toContain("awaiting-approval");
  });

  it("returns reason when task needs-replan", () => {
    // scheduler/executor/triage move a task here when its plan must be revisited.
    expect(getTaskMergeBlocker({ ...baseTask, status: "needs-replan" }))
      .toContain("needs-replan");
  });

  it("returns reason when task is in mission-validation", () => {
    expect(getTaskMergeBlocker({ ...baseTask, status: "mission-validation" }))
      .toContain("mission-validation");
  });

  it("returns reason when task is queued (scheduler transient)", () => {
    expect(getTaskMergeBlocker({ ...baseTask, status: "queued" }))
      .toContain("queued");
  });

  it("bypasses queued status when merge is manual", () => {
    expect(getTaskMergeBlocker({ ...baseTask, status: "queued" }, { manual: true }))
      .toBeUndefined();
  });

  it("still blocks hard statuses for manual merge", () => {
    for (const status of HARD_BLOCKING_TASK_STATUSES) {
      expect(getTaskMergeBlocker({ ...baseTask, status }, { manual: true }))
        .toContain(status);
    }
  });

  it("manual merge preserves non-status hard guards", () => {
    expect(getTaskMergeBlocker({ ...baseTask, paused: true }, { manual: true }))
      .toBe("task is paused");
    expect(getTaskMergeBlocker({ ...baseTask, column: "todo" }, { manual: true }))
      .toContain("must be in 'in-review'");
    expect(getTaskMergeBlocker({
      ...baseTask,
      steps: [{ name: "Step 1", status: "pending" }],
    }, { manual: true })).toBe("task has incomplete steps");
    expect(getTaskMergeBlocker({
      ...baseTask,
      workflowStepResults: [{
        workflowStepId: "WS-001",
        workflowStepName: "Pre-merge Check",
        phase: "pre-merge",
        status: "failed",
      }],
    }, { manual: true })).toBe("task has failed pre-merge workflow steps");
  });

  it("manual false preserves default blocking behavior", () => {
    expect(getTaskMergeBlocker({ ...baseTask, status: "queued" }, { manual: false }))
      .toContain("queued");
  });

  it("blocking status partitions remain backward compatible", () => {
    expect(SCHEDULER_TRANSIENT_STATUSES.has("queued")).toBe(true);
    for (const status of HARD_BLOCKING_TASK_STATUSES) {
      expect(BLOCKING_TASK_STATUSES.has(status)).toBe(true);
    }
    for (const status of SCHEDULER_TRANSIENT_STATUSES) {
      expect(BLOCKING_TASK_STATUSES.has(status)).toBe(true);
    }
  });

  it("returns reason when task is stuck-killed", () => {
    // Defensive: if this transient marker surfaces in in-review, the task
    // needs investigation rather than auto-merge.
    expect(getTaskMergeBlocker({ ...baseTask, status: "stuck-killed" }))
      .toContain("stuck-killed");
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

  it("does NOT block merge on advisory pre-merge workflow findings", () => {
    const result = getTaskMergeBlocker({
      ...baseTask,
      workflowStepResults: [{
        workflowStepId: "WS-001",
        workflowStepName: "Frontend UX Design",
        phase: "pre-merge",
        status: "advisory_failure",
        notes: "Polish spacing in header actions.",
      }],
    });
    expect(result).toBeUndefined();
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

describe("getTaskHardMergeBlocker", () => {
  it("ignores paused when no hard blockers exist", () => {
    expect(getTaskHardMergeBlocker({ ...baseTask, paused: true })).toBeUndefined();
  });

  it("ignores failed status when no hard blockers exist", () => {
    expect(getTaskHardMergeBlocker({ ...baseTask, status: "failed" })).toBeUndefined();
  });

  it("still blocks on awaiting-user-review", () => {
    expect(getTaskHardMergeBlocker({ ...baseTask, status: "awaiting-user-review" }))
      .toContain("awaiting-user-review");
  });

  it("still blocks on incomplete steps", () => {
    expect(getTaskHardMergeBlocker({
      ...baseTask,
      steps: [{ name: "Step 1", status: "pending" }],
    })).toBe("task has incomplete steps");
  });

  it("still blocks on failed pre-merge workflow step", () => {
    expect(getTaskHardMergeBlocker({
      ...baseTask,
      workflowStepResults: [{
        workflowStepId: "WS-001",
        workflowStepName: "Pre-merge Check",
        phase: "pre-merge",
        status: "failed",
      }],
    })).toBe("task has failed pre-merge workflow steps");
  });

  it("still blocks when task is not in-review", () => {
    expect(getTaskHardMergeBlocker({ ...baseTask, column: "todo" }))
      .toContain("must be in 'in-review'");
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

  it("returns a reason when task has blockedBy without resolveTask", async () => {
    await expect(getTaskCompletionBlocker({ ...baseCompletionTask, blockedBy: "FN-123" }))
      .resolves.toBe("task is blocked by FN-123");
  });

  it("ignores blockedBy when resolveTask reports the blocker missing", async () => {
    const resolveTask = async () => null;

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      blockedBy: "FN-4054",
    }, { resolveTask })).resolves.toBeUndefined();
  });

  it("treats soft-deleted blockedBy as non-blocking when resolveTask returns null", async () => {
    const resolveTask = async (_taskId: string) => null;

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      blockedBy: "FN-SOFT-DELETED",
    }, { resolveTask })).resolves.toBeUndefined();
  });

  it.each(["done", "archived"] as const)("ignores blockedBy when resolveTask reports the blocker is %s", async (column) => {
    const resolveTask = async () => ({ id: "FN-4054", column });

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      blockedBy: "FN-4054",
    }, { resolveTask })).resolves.toBeUndefined();
  });

  it.each(["todo", "in-progress", "in-review"] as const)("returns a reason when resolveTask reports an active blocker in %s", async (column) => {
    const resolveTask = async () => ({ id: "FN-123", column });

    await expect(getTaskCompletionBlocker({
      ...baseCompletionTask,
      blockedBy: "FN-123",
    }, { resolveTask })).resolves.toBe("task is blocked by FN-123");
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

import { describe, it, expect } from "vitest";
import type { PrInfo, StepStatus } from "../types.js";
import {
  BLOCKING_TASK_STATUSES,
  HARD_BLOCKING_TASK_STATUSES,
  SCHEDULER_TRANSIENT_STATUSES,
  TASK_DONE_BYPASS_BLOCKER_MESSAGE,
  AWAITING_APPROVAL_PAUSE_REASON,
  isTaskBlockedOnApproval,
  getTaskCompletionBlocker,
  getTaskDoneBypassBlocker,
  getTaskHardMergeBlocker,
  getTaskMergeBlocker,
  isTaskReadyForMerge,
  allowsAutoMergeProcessing,
  isSharedBranchGroupMemberIntegration,
  isLiveSharedBranchGroupMemberIntegration,
  resolveEffectiveAutoMerge,
  resolveEffectiveGroupAutoMerge,
  resolveTaskMergeTarget,
} from "../merge/task-merge.js";

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

function prInfo(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    url: "https://github.com/owner/repo/pull/1",
    number: 1,
    status: "open",
    title: "PR",
    headBranch: "fusion/fn-001",
    baseBranch: "main",
    commentCount: 0,
    ...overrides,
  };
}

describe("resolveEffectiveAutoMerge", () => {
  it("prefers explicit true over global false", () => {
    expect(resolveEffectiveAutoMerge({ autoMerge: true }, { autoMerge: false })).toBe(true);
  });

  it("prefers explicit false over global true", () => {
    expect(resolveEffectiveAutoMerge({ autoMerge: false }, { autoMerge: true })).toBe(false);
  });

  it("falls back to global true when task value is undefined", () => {
    expect(resolveEffectiveAutoMerge({ autoMerge: undefined }, { autoMerge: true })).toBe(true);
  });

  it("falls back to global false when task value is undefined", () => {
    expect(resolveEffectiveAutoMerge({ autoMerge: undefined }, { autoMerge: false })).toBe(false);
  });

  it("tracks live global toggles while task value remains undefined", () => {
    const task = { autoMerge: undefined };
    expect(resolveEffectiveAutoMerge(task, { autoMerge: true })).toBe(true);
    expect(resolveEffectiveAutoMerge(task, { autoMerge: false })).toBe(false);
    expect(resolveEffectiveAutoMerge(task, { autoMerge: true })).toBe(true);
  });

  it("treats provenance as metadata and resolves solely from the value", () => {
    expect(resolveEffectiveAutoMerge({ autoMerge: true, autoMergeProvenance: "legacy-stamp" }, { autoMerge: false })).toBe(true);
    expect(resolveEffectiveAutoMerge({ autoMerge: false, autoMergeProvenance: "user" }, { autoMerge: true })).toBe(false);
    expect(resolveEffectiveAutoMerge({ autoMerge: undefined, autoMergeProvenance: undefined }, { autoMerge: true })).toBe(true);
  });
});

describe("allowsAutoMergeProcessing", () => {
  it("lets explicit per-task true with user provenance through when the global setting is off", () => {
    expect(allowsAutoMergeProcessing({ autoMerge: true, autoMergeProvenance: "user" }, { autoMerge: false })).toBe(true);
  });

  it("still lets legacy-stamp true through at the gate so reconcile, not the gate, owns cleanup", () => {
    expect(allowsAutoMergeProcessing({ autoMerge: true, autoMergeProvenance: "legacy-stamp" }, { autoMerge: false })).toBe(true);
  });

  it("blocks tasks without an explicit override when the global setting is off", () => {
    const task = { autoMerge: undefined };
    expect(allowsAutoMergeProcessing(task, { autoMerge: true })).toBe(true);
    expect(allowsAutoMergeProcessing(task, { autoMerge: false })).toBe(false);
    expect(allowsAutoMergeProcessing(task, { autoMerge: true })).toBe(true);
    expect(allowsAutoMergeProcessing({ autoMerge: false, autoMergeProvenance: "user" }, { autoMerge: false })).toBe(false);
  });

  it("lets everything through when the global setting is on — explicit false still flows so the merger can park it manual-required", () => {
    expect(allowsAutoMergeProcessing({ autoMerge: undefined }, { autoMerge: true })).toBe(true);
    expect(allowsAutoMergeProcessing({ autoMerge: true }, { autoMerge: true })).toBe(true);
    expect(allowsAutoMergeProcessing({ autoMerge: false }, { autoMerge: true })).toBe(true);
  });

  it("blocks an open or draft manually-created PR even when global auto-merge is on", () => {
    expect(allowsAutoMergeProcessing({
      autoMerge: undefined,
      prInfos: [prInfo({ manual: true })],
    }, { autoMerge: true })).toBe(false);
    expect(allowsAutoMergeProcessing({
      autoMerge: undefined,
      prInfos: [prInfo({ manual: true, status: "draft" })],
    }, { autoMerge: true })).toBe(false);
  });

  it("does not block once a manually-created PR is closed or merged", () => {
    expect(allowsAutoMergeProcessing({
      autoMerge: undefined,
      prInfos: [prInfo({ manual: true, status: "merged" })],
    }, { autoMerge: true })).toBe(true);
    expect(allowsAutoMergeProcessing({
      autoMerge: undefined,
      prInfos: [prInfo({ manual: true, status: "closed" })],
    }, { autoMerge: true })).toBe(true);
  });

  it("does not block a pipeline-created open PR without the manual flag", () => {
    expect(allowsAutoMergeProcessing({
      autoMerge: undefined,
      prInfos: [prInfo()],
    }, { autoMerge: true })).toBe(true);
  });

  it("preserves no-PR and explicit override behavior", () => {
    expect(allowsAutoMergeProcessing({ autoMerge: undefined }, { autoMerge: true })).toBe(true);
    expect(allowsAutoMergeProcessing({ autoMerge: true }, { autoMerge: false })).toBe(true);
  });

  it("checks the legacy single prInfo and multi prInfos shapes", () => {
    expect(allowsAutoMergeProcessing({
      autoMerge: undefined,
      prInfo: prInfo({ manual: true }),
    }, { autoMerge: true })).toBe(false);
    expect(allowsAutoMergeProcessing({
      autoMerge: undefined,
      prInfos: [prInfo({ number: 1 }), prInfo({ number: 2, manual: true })],
    }, { autoMerge: true })).toBe(false);
  });
});

describe("resolveEffectiveGroupAutoMerge", () => {
  it("prefers explicit true over global false", () => {
    expect(resolveEffectiveGroupAutoMerge({ autoMerge: true }, { autoMerge: false })).toBe(true);
  });

  it("prefers explicit false over global true", () => {
    expect(resolveEffectiveGroupAutoMerge({ autoMerge: false }, { autoMerge: true })).toBe(false);
  });

  it("group and per-task resolvers stay independent", () => {
    expect(resolveEffectiveAutoMerge({ autoMerge: false }, { autoMerge: true })).toBe(false);
    expect(resolveEffectiveGroupAutoMerge({ autoMerge: true }, { autoMerge: false })).toBe(true);
    expect(resolveEffectiveAutoMerge({ autoMerge: true }, { autoMerge: false })).toBe(true);
    expect(resolveEffectiveGroupAutoMerge({ autoMerge: false }, { autoMerge: true })).toBe(false);
  });
});

describe("isSharedBranchGroupMemberIntegration", () => {
  const sharedTask = {
    branchContext: {
      assignmentMode: "shared" as const,
      groupId: "BG-1",
      source: "planning" as const,
    },
  };

  it("returns true for shared members with a resolvable group id", () => {
    expect(isSharedBranchGroupMemberIntegration(sharedTask)).toBe(true);
  });

  it("returns false for per-task-derived grouped members", () => {
    expect(isSharedBranchGroupMemberIntegration({
      branchContext: {
        assignmentMode: "per-task-derived",
        groupId: "BG-1",
        source: "planning",
      },
    })).toBe(false);
  });

  it("returns false when no group id is present", () => {
    expect(isSharedBranchGroupMemberIntegration({
      branchContext: {
        assignmentMode: "shared",
        groupId: "   ",
        source: "planning",
      },
    })).toBe(false);
  });

  it("returns false when branch context is absent", () => {
    expect(isSharedBranchGroupMemberIntegration({ branchContext: undefined })).toBe(false);
  });

  it("requires a live open group for auto-merge-off shared-member integration", () => {
    expect(isLiveSharedBranchGroupMemberIntegration(sharedTask, { status: "open" })).toBe(true);
    expect(isLiveSharedBranchGroupMemberIntegration(sharedTask, { status: "finalized" })).toBe(false);
    expect(isLiveSharedBranchGroupMemberIntegration(sharedTask, { status: "abandoned" })).toBe(false);
    expect(isLiveSharedBranchGroupMemberIntegration(sharedTask, null)).toBe(false);
    expect(isLiveSharedBranchGroupMemberIntegration(sharedTask, undefined)).toBe(false);
  });

  it("does not grant the live-group exemption to non-shared or blank-group contexts", () => {
    expect(isLiveSharedBranchGroupMemberIntegration({
      branchContext: {
        assignmentMode: "per-task-derived",
        groupId: "BG-1",
        source: "planning",
      },
    }, { status: "open" })).toBe(false);
    expect(isLiveSharedBranchGroupMemberIntegration({
      branchContext: {
        assignmentMode: "shared",
        groupId: "   ",
        source: "planning",
      },
    }, { status: "open" })).toBe(false);
  });
});

describe("resolveTaskMergeTarget", () => {
  it("prefers task baseBranch when present", () => {
    expect(resolveTaskMergeTarget({ baseBranch: "release/1.2", branchContext: undefined })).toEqual({
      branch: "release/1.2",
      source: "task-base-branch",
    });
  });

  it("routes shared branch-group members to branch group integration branch", () => {
    expect(resolveTaskMergeTarget({
      baseBranch: undefined,
      branchContext: {
        groupId: "G-1",
        source: "planning",
        assignmentMode: "shared",
        inheritedBaseBranch: "develop",
      },
    }, {
      branchGroup: {
        branchName: "fusion/groups/planning-g-1",
      },
    })).toEqual({
      branch: "fusion/groups/planning-g-1",
      source: "branch-group-integration",
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

  it("keeps per-task-derived grouped members on inherited branch context", () => {
    expect(resolveTaskMergeTarget({
      baseBranch: undefined,
      branchContext: {
        groupId: "G-2",
        source: "planning",
        assignmentMode: "per-task-derived",
        inheritedBaseBranch: "develop",
      },
    }, {
      branchGroup: {
        branchName: "fusion/groups/planning-g-2",
      },
    })).toEqual({
      branch: "develop",
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

  it("rejects branch-group integration branch when it points at a sibling fusion/fn-* branch", () => {
    const result = resolveTaskMergeTarget(
      {
        baseBranch: undefined,
        branchContext: {
          groupId: "G-1",
          source: "planning",
          assignmentMode: "shared",
        },
      },
      {
        branchGroup: {
          branchName: "fusion/fn-1234",
        },
        projectDefaultBranch: "main",
      },
    );
    expect(result.branch).toBe("main");
    expect(result.source).toBe("project-default");
    expect(result.rejected).toEqual({
      branch: "fusion/fn-1234",
      source: "branch-group-integration",
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

describe("getTaskDoneBypassBlocker", () => {
  it("requires merge proof or explicit no-commits policy", () => {
    expect(getTaskDoneBypassBlocker({ noCommitsExpected: undefined, mergeDetails: undefined, prInfo: undefined, prInfos: undefined }))
      .toBe(TASK_DONE_BYPASS_BLOCKER_MESSAGE);
  });

  it("allows explicit no-commits policy", () => {
    expect(getTaskDoneBypassBlocker({ noCommitsExpected: true, mergeDetails: undefined, prInfo: undefined, prInfos: undefined }))
      .toBeUndefined();
  });

  it("allows durable merge confirmation", () => {
    expect(getTaskDoneBypassBlocker({ noCommitsExpected: undefined, mergeDetails: { mergeConfirmed: true }, prInfo: undefined, prInfos: undefined }))
      .toBeUndefined();
  });

  it("allows observed merged PR proof", () => {
    expect(getTaskDoneBypassBlocker({ noCommitsExpected: undefined, mergeDetails: undefined, prInfo: prInfo({ status: "merged" }), prInfos: undefined }))
      .toBeUndefined();
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

// FN-7736: isTaskBlockedOnApproval covers both approval-hold shapes (pause-reason
// and awaiting-approval status) and must not false-positive on a bare user pause.
describe("isTaskBlockedOnApproval", () => {
  it("is true when paused with the canonical approval pause reason", () => {
    expect(isTaskBlockedOnApproval({ paused: true, pausedReason: AWAITING_APPROVAL_PAUSE_REASON, status: undefined })).toBe(true);
  });

  it("is true when status is awaiting-approval regardless of paused", () => {
    expect(isTaskBlockedOnApproval({ paused: false, pausedReason: undefined, status: "awaiting-approval" })).toBe(true);
  });

  it("is true when both the pause-reason and status shapes are present", () => {
    expect(isTaskBlockedOnApproval({ paused: true, pausedReason: AWAITING_APPROVAL_PAUSE_REASON, status: "awaiting-approval" })).toBe(true);
  });

  it("is false for a task with neither hold shape", () => {
    expect(isTaskBlockedOnApproval({ paused: false, pausedReason: undefined, status: undefined })).toBe(false);
  });

  it("is false for a bare user pause (paused true, no reason) — must not conflate with approval hold", () => {
    expect(isTaskBlockedOnApproval({ paused: true, pausedReason: undefined, status: undefined })).toBe(false);
  });

  it("is false when paused with a different (non-approval) pause reason", () => {
    expect(isTaskBlockedOnApproval({ paused: true, pausedReason: "branch-conflict-unrecoverable", status: undefined })).toBe(false);
  });

  it("is false when pausedReason is the approval reason but paused is not true", () => {
    expect(isTaskBlockedOnApproval({ paused: false, pausedReason: AWAITING_APPROVAL_PAUSE_REASON, status: undefined })).toBe(false);
  });
});

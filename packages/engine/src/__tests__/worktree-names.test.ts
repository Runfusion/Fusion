import { describe, expect, it } from "vitest";
import { canonicalStepInstanceBranchName, planTaskWorktreePath, resolveTaskWorkingBranch } from "../worktree/worktree-names.js";

describe("resolveTaskWorkingBranch", () => {
  it("returns canonical per-task branch for shared assignment mode", () => {
    expect(resolveTaskWorkingBranch({ id: "FN-5818", branch: "clionboarding", branchContext: { assignmentMode: "shared", groupId: "bg-1", source: "planning" } })).toBe("fusion/fn-5818");
  });

  it("returns explicit branch for per-task-derived assignment mode", () => {
    expect(resolveTaskWorkingBranch({ id: "FN-5818", branch: "fusion/custom", branchContext: { assignmentMode: "per-task-derived", groupId: "bg-1", source: "planning" } })).toBe("fusion/custom");
  });

  it("returns canonical branch for ungrouped task without branch", () => {
    expect(resolveTaskWorkingBranch({ id: "FN-5818", branch: undefined })).toBe("fusion/fn-5818");
  });
});

describe("canonicalStepInstanceBranchName", () => {
  it("aligns each parallel-step branch with its task-id-derived worktree identity", () => {
    expect(canonicalStepInstanceBranchName("FN-258", 2)).toBe("fusion/fn-258-step-2");
  });
});

describe("planTaskWorktreePath", () => {
  it("derives the worktree from the lower-cased task ID regardless of legacy naming inputs", () => {
    expect(planTaskWorktreePath(
      { id: "FN-258", description: "unused" },
      "/repo",
      new Set(["gentle-panda"]),
    )).toBe("/repo/.fusion/worktrees/fn-258");
  });

  it("preserves an existing task worktree pointer until acquisition corrects it", () => {
    expect(planTaskWorktreePath(
      { id: "FN-258", description: "unused", worktree: "/existing" },
      "/repo",
    )).toBe("/existing");
  });
});

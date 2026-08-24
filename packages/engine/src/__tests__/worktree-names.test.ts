import { describe, expect, it } from "vitest";
import { join } from "node:path";
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
  it("derives the worktree from the lower-cased task ID when naming is unset", () => {
    expect(planTaskWorktreePath(
      { id: "FN-258", description: "unused" },
      "/repo",
      new Set(["gentle-panda"]),
    )).toBe("/repo/.fusion/worktrees/fn-258");
  });

  it("names a single-repo worktree from the working branch in branch mode", () => {
    expect(planTaskWorktreePath(
      { id: "FN-258", description: "unused", branch: "feature/PRD-1234-my-slug" },
      "/repo",
      new Set(),
      { worktreeNaming: "branch" },
    )).toBe("/repo/.fusion/worktrees/prd-1234-my-slug");
  });

  it("preserves an existing task worktree pointer until acquisition corrects it", () => {
    expect(planTaskWorktreePath(
      { id: "FN-258", description: "unused", worktree: "/existing" },
      "/repo",
    )).toBe("/existing");
  });
});

/*
FNXC:WorkspaceWorktree 2026-08-24-06:11:
R14: the `branch` naming mode has to work on the SINGLE-repository path too, or an operator who
selects it for a normal project silently gets random names. This is the planner site (scheduler
dispatch and the manual-move route); the acquisition-time site is covered in
worktree-acquisition-workspace.test.ts. The fallback ladder is shared with the workspace path, so
these cases pin the wiring and the degradation, not the slug algorithm.
*/
describe("planTaskWorktreePath branch naming", () => {
  const rootDir = "/tmp/fn-branch-naming-root";
  const task = (overrides: Record<string, unknown> = {}) => ({
    id: "FN-9300",
    title: "A title",
    description: "a description",
    branch: "feature/PRD-1234-my-slug",
    ...overrides,
  });

  it("names the directory after the ticket the branch identifies", () => {
    expect(planTaskWorktreePath(task(), rootDir, new Set(), { worktreeNaming: "branch" }))
      .toBe(join(rootDir, ".fusion", "worktrees", "prd-1234-my-slug"));
  });

  it("drops the namespace and lowercases", () => {
    expect(planTaskWorktreePath(task({ branch: "PRD-1234-MY-SLUG" }), rootDir, new Set(), { worktreeNaming: "branch" }))
      .toBe(join(rootDir, ".fusion", "worktrees", "prd-1234-my-slug"));
  });

  it("falls back to the task id for a branch that slugs to empty", () => {
    expect(planTaskWorktreePath(task({ branch: "feature/---" }), rootDir, new Set(), { worktreeNaming: "branch" }))
      .toBe(join(rootDir, ".fusion", "worktrees", "fn-9300"));
  });

  it("falls back to the task id for a reserved container name in any case", () => {
    expect(planTaskWorktreePath(task({ branch: "feature/.AI-Merge" }), rootDir, new Set(), { worktreeNaming: "branch" }))
      .toBe(join(rootDir, ".fusion", "worktrees", "fn-9300"));
  });

  it("falls back to the task id when the slug is already reserved in this dispatch", () => {
    expect(planTaskWorktreePath(task(), rootDir, new Set(["prd-1234-my-slug"]), { worktreeNaming: "branch" }))
      .toBe(join(rootDir, ".fusion", "worktrees", "fn-9300"));
  });

  it("derives the canonical fusion branch when the task carries none", () => {
    expect(planTaskWorktreePath(task({ branch: undefined }), rootDir, new Set(), { worktreeNaming: "branch" }))
      .toBe(join(rootDir, ".fusion", "worktrees", "fn-9300"));
  });

  it("reuses an already-assigned worktree regardless of mode", () => {
    expect(planTaskWorktreePath(task({ worktree: "/tmp/existing/dir" }), rootDir, new Set(), { worktreeNaming: "branch" }))
      .toBe("/tmp/existing/dir");
  });
});

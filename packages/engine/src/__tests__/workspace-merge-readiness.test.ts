import { describe, expect, it } from "vitest";
import { resolveWorkspaceMergeReadiness } from "../merge/workspace-merge-readiness.js";

const task = {
  id: "FN-106",
  repositoryScope: { state: "confirmed" as const, repositories: ["Merge-Auth"] },
  workspaceWorktrees: {
    "Merge-Auth": { worktreePath: "/workspace/Merge-Auth/.worktrees/fn-106", branch: "fusion/fn-106", landedSha: "a".repeat(40) },
  },
  modifiedFiles: ["Merge-Auth/src/auth.ts"],
};

describe("workspace merge readiness", () => {
  it("keeps an already-landed confirmed repository as the second-pass obligation", () => {
    expect(resolveWorkspaceMergeReadiness(task, new Set(), new Set())).toEqual({
      kind: "ready",
      repositories: ["Merge-Auth"],
      preservedFiles: ["Merge-Auth/src/auth.ts"],
    });
  });

  it("fails closed instead of deriving all-landed from unexplained emptiness", () => {
    expect(resolveWorkspaceMergeReadiness({ ...task, workspaceWorktrees: { "Merge-Auth": { ...task.workspaceWorktrees["Merge-Auth"], landedSha: undefined } } }, new Set(), new Set())).toMatchObject({ kind: "blocked" });
  });

  it("rejects malformed persisted duplicate declarations and worktree paths", () => {
    expect(resolveWorkspaceMergeReadiness({
      ...task,
      repositoryScope: { state: "confirmed", repositories: ["Merge-Auth", "Merge-Auth"] },
    }, new Set(), new Set())).toMatchObject({ kind: "blocked", reason: expect.stringContaining("duplicate") });

    expect(resolveWorkspaceMergeReadiness({
      ...task,
      repositoryScope: { state: "confirmed", repositories: ["Merge", "Merge-Auth"] },
      workspaceWorktrees: {
        Merge: { worktreePath: "/workspace/shared/.worktrees/fn-106", branch: "fusion/fn-106" },
        "Merge-Auth": { worktreePath: "/workspace/shared/.worktrees/fn-106", branch: "fusion/fn-106", landedSha: "a".repeat(40) },
      },
    }, new Set(), new Set())).toMatchObject({ kind: "blocked", reason: expect.stringContaining("duplicate worktree") });
  });

  it("permits only an explicit commit-free task to take the no-op path", () => {
    expect(resolveWorkspaceMergeReadiness({ ...task, noCommitsExpected: true, workspaceWorktrees: {} }, new Set(), new Set())).toMatchObject({ kind: "blocked" });
    expect(resolveWorkspaceMergeReadiness({ ...task, noCommitsExpected: true, repositoryScope: { state: "confirmed", repositories: [] }, workspaceWorktrees: {} }, new Set(), new Set())).toMatchObject({ kind: "no-op" });
  });
});

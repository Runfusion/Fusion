/*
FNXC:WorkspaceLifecycleParity 2026-08-21-00:12:
A workspace task that changes one explicitly scoped repository must make the same review decision
as its mono-repository equivalent. Acquisition of a clean peer is deliberately included here to
prove it neither receives a reviewer session nor changes the approval outcome.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { reviewWorkspacePerRepo } from "../executor/workspace-review-per-repo.js";

function task(overrides: Partial<Task>): Task {
  return {
    id: "FN-094", title: "parity", description: "", column: "in-review", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z", ...overrides,
  } as Task;
}

describe("FN-094 workspace lifecycle parity", () => {
  it("reviews one scoped modified repository exactly like the mono-repository case", async () => {
    const review = vi.fn(async () => ({ verdict: "APPROVE" as const, review: "approved", summary: "approved" }));
    const workspace = task({
      repositoryScope: { repositories: ["repo-a", "repo-b"], state: "confirmed", revision: 2 },
      modifiedFiles: ["repo-a/src/changed.ts"],
      workspaceWorktrees: {
        "repo-a": { worktreePath: "/workspace/repo-a/.worktrees/fn-094", branch: "fusion/fn-094" },
        "repo-b": { worktreePath: "/workspace/repo-b/.worktrees/fn-094", branch: "fusion/fn-094" },
      },
    });
    const result = await reviewWorkspacePerRepo(workspace, review, { workspaceRepos: ["repo-a", "repo-b"], workspaceRootDir: "/workspace", captureModifiedFiles: async (repoRel) => repoRel === "repo-a" ? ["src/changed.ts"] : [] });

    expect(result.verdict).toBe("APPROVE");
    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith("/workspace/repo-a/.worktrees/fn-094");
    expect(result.review).toContain("[repo-b] NOT_REVIEWED");
    expect(result.review).toContain("No changes — not reviewed");
  });

  it("does not dispatch Code Review from a proposed scope", async () => {
    const review = vi.fn();
    const result = await reviewWorkspacePerRepo(task({
      repositoryScope: { repositories: ["repo-a"], state: "proposed", revision: 1 },
      workspaceWorktrees: { "repo-a": { worktreePath: "/workspace/repo-a/.worktrees/fn-094", branch: "fusion/fn-094" } },
    }), review, { workspaceRepos: ["repo-a"], workspaceRootDir: "/workspace", captureModifiedFiles: async () => ["src/changed.ts"] });

    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.retryable).toBe(false);
    expect(review).not.toHaveBeenCalled();
  });

  it("refuses an ordinary all-clean scoped implementation without inventing a blocking clean-peer verdict", async () => {
    const review = vi.fn();
    const result = await reviewWorkspacePerRepo(task({
      repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 1 },
      workspaceWorktrees: { "repo-a": { worktreePath: "/workspace/repo-a/.worktrees/fn-094", branch: "fusion/fn-094" } },
    }), review, { workspaceRepos: ["repo-a"], workspaceRootDir: "/workspace", captureModifiedFiles: async () => [] });

    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.retryable).toBe(false);
    expect(review).not.toHaveBeenCalled();
    expect(result.review).toContain("No changes — not reviewed");
  });
});

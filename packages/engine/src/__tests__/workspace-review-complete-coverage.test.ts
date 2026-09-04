/*
FNXC:WorkspaceReviewCoverage 2026-08-28-11:50:
FN-223 requires symptom-level coverage that one workspace Code Review episode visits every modified
in-scope repository and returns one deterministic verdict containing all repository-qualified findings.
*/
import { describe, expect, it, vi } from "vitest";

import type { Task } from "@fusion/core";
import { ReviewerProviderError, type ReviewResult } from "../execution/reviewer.js";
import { reviewWorkspacePerRepo } from "../executor/workspace-review-per-repo.js";

const WORKTREES = {
  "repo-a": "/workspace/checkouts/repo-a",
  "repo-b": "/workspace/checkouts/repo-b",
  "repo-c": "/workspace/checkouts/repo-c",
} as const;

function workspaceTask(repositories = Object.keys(WORKTREES)): Task {
  return {
    id: "FN-223",
    column: "in-review",
    repositoryScope: { state: "confirmed", revision: 7, repositories },
    workspaceWorktrees: Object.fromEntries(repositories.map((repository) => [repository, {
      worktreePath: WORKTREES[repository as keyof typeof WORKTREES],
      baseCommitSha: `base-${repository}`,
    }])),
  } as unknown as Task;
}

async function runReview(results: Record<string, ReviewResult>, repositories = Object.keys(WORKTREES)) {
  const invokeForCwd = vi.fn(async (cwd: string) => results[cwd.slice(cwd.lastIndexOf("/") + 1)]);
  const aggregate = await reviewWorkspacePerRepo(workspaceTask(repositories), invokeForCwd, {
    workspaceRepos: repositories,
    workspaceRootDir: "/workspace",
    captureModifiedFiles: async (repository) => [`src/${repository}.ts`],
  });
  return { aggregate, invokeForCwd };
}

function result(verdict: ReviewResult["verdict"], repository: string, withFinding = false): ReviewResult {
  return {
    verdict,
    review: `${verdict} review for ${repository}`,
    summary: `${verdict} summary for ${repository}`,
    ...(withFinding ? {
      findings: [{
        id: "finding-1",
        title: `${repository} finding`,
        body: `Fix ${repository}`,
        filePath: `src/${repository}.ts`,
      }],
    } : {}),
  };
}

describe("workspace Code Review complete coverage", () => {
  it("reviews all modified repositories and returns every qualified finding in one verdict", async () => {
    const { aggregate, invokeForCwd } = await runReview({
      "repo-a": result("REVISE", "repo-a", true),
      "repo-b": result("APPROVE", "repo-b"),
      "repo-c": result("REVISE", "repo-c", true),
    });

    expect(invokeForCwd.mock.calls.map(([cwd]) => cwd)).toEqual([
      WORKTREES["repo-a"],
      WORKTREES["repo-b"],
      WORKTREES["repo-c"],
    ]);
    expect(aggregate.verdict).toBe("REVISE");
    expect(aggregate.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "repo-a:finding-1", filePath: "repo-a/src/repo-a.ts" }),
      expect.objectContaining({ id: "repo-c:finding-1", filePath: "repo-c/src/repo-c.ts" }),
    ]));
    expect(aggregate.repositoryReviewOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ repository: "repo-a", status: "REVIEWED", verdict: "REVISE" }),
      expect.objectContaining({ repository: "repo-b", status: "REVIEWED", verdict: "APPROVE" }),
      expect.objectContaining({ repository: "repo-c", status: "REVIEWED", verdict: "REVISE" }),
    ]));
    expect(aggregate.review).not.toContain("evaluation stopped at first failure");
    expect(aggregate.review).toContain("All 3 modified in-scope sub-repository review(s) were evaluated");
    expect(aggregate.review).toContain("Blocking repositories: repo-a, repo-c");
  });

  it("preserves an earlier rejection when a later repository reviewer throws", async () => {
    const provider = vi.fn(async (cwd: string): Promise<ReviewResult> => {
      if (cwd === WORKTREES["repo-b"]) throw new Error("repo-b reviewer failed");
      return result("REVISE", "repo-a", true);
    });
    const aggregate = await reviewWorkspacePerRepo(workspaceTask(["repo-a", "repo-b"]), provider, {
      workspaceRepos: ["repo-a", "repo-b"],
      workspaceRootDir: "/workspace",
      captureModifiedFiles: async (repository) => [`src/${repository}.ts`],
    });

    expect(provider.mock.calls.map(([cwd]) => cwd)).toEqual([WORKTREES["repo-a"], WORKTREES["repo-b"]]);
    expect(aggregate.verdict).toBe("REVISE");
    expect(aggregate.findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: "repo-a:finding-1" })]));
    expect(aggregate.repositoryReviewOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ repository: "repo-b", status: "REVIEWED", verdict: "UNAVAILABLE", output: "reviewer error: repo-b reviewer failed" }),
    ]));
    expect(aggregate.review).toContain("Not covered by a verdict: repo-b");
  });

  it("records an unavailable outcome when every repository reviewer throws", async () => {
    const provider = vi.fn(async (cwd: string): Promise<ReviewResult> => {
      throw new Error(`${cwd} failed`);
    });
    const aggregate = await reviewWorkspacePerRepo(workspaceTask(), provider, {
      workspaceRepos: Object.keys(WORKTREES),
      workspaceRootDir: "/workspace",
      captureModifiedFiles: async (repository) => [`src/${repository}.ts`],
    });

    expect(provider).toHaveBeenCalledTimes(3);
    expect(aggregate.verdict).toBe("UNAVAILABLE");
    expect(aggregate.repositoryReviewOutcomes?.filter((outcome) => outcome.status === "REVIEWED" && outcome.verdict === "UNAVAILABLE")).toHaveLength(3);
    expect(aggregate.review).toContain("Not covered by a verdict: repo-a, repo-b, repo-c");
  });

  it("aborts the episode and rethrows a reviewer provider failure unchanged", async () => {
    const providerError = new ReviewerProviderError("provider rate limited", "usage-limit", { provider: "anthropic" });
    const provider = vi.fn(async (cwd: string): Promise<ReviewResult> => {
      if (cwd === WORKTREES["repo-b"]) throw providerError;
      return result("REVISE", "repo-a", true);
    });
    const review = reviewWorkspacePerRepo(workspaceTask(), provider, {
      workspaceRepos: Object.keys(WORKTREES),
      workspaceRootDir: "/workspace",
      captureModifiedFiles: async (repository) => [`src/${repository}.ts`],
    });

    await expect(review).rejects.toBe(providerError);
    expect(provider.mock.calls.map(([cwd]) => cwd)).toEqual([WORKTREES["repo-a"], WORKTREES["repo-b"]]);
  });

  it("reviews an approving prefix before a last-repository blocker", async () => {
    const { aggregate, invokeForCwd } = await runReview({
      "repo-a": result("APPROVE", "repo-a"),
      "repo-b": result("APPROVE", "repo-b"),
      "repo-c": result("REVISE", "repo-c"),
    });

    expect(invokeForCwd).toHaveBeenCalledTimes(3);
    expect(aggregate.verdict).toBe("REVISE");
    expect(aggregate.repositoryReviewOutcomes?.filter((outcome) => outcome.status === "REVIEWED")).toHaveLength(3);
  });

  it.each([
    [["repo-a", "repo-b"], { "repo-a": "REVISE", "repo-b": "RETHINK" }],
    [["repo-b", "repo-a"], { "repo-a": "REVISE", "repo-b": "RETHINK" }],
  ] as const)("selects RETHINK over REVISE regardless of repository declaration order %#", async (repositories, verdicts) => {
    const { aggregate, invokeForCwd } = await runReview(Object.fromEntries(Object.entries(verdicts).map(([repository, verdict]) => [
      repository,
      result(verdict, repository),
    ])), [...repositories]);

    expect(invokeForCwd.mock.calls.map(([cwd]) => cwd)).toEqual([WORKTREES["repo-a"], WORKTREES["repo-b"]]);
    expect(aggregate.verdict).toBe("RETHINK");
  });

  it("keeps REVISE stronger than a later UNAVAILABLE verdict", async () => {
    const { aggregate } = await runReview({
      "repo-a": result("REVISE", "repo-a"),
      "repo-b": result("UNAVAILABLE", "repo-b"),
    }, ["repo-a", "repo-b"]);

    expect(aggregate.verdict).toBe("REVISE");
    expect(aggregate.repositoryReviewOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ repository: "repo-a", verdict: "REVISE" }),
      expect.objectContaining({ repository: "repo-b", verdict: "UNAVAILABLE" }),
    ]));
  });
});

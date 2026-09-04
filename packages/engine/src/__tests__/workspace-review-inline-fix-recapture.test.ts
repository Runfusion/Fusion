import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { evaluatePreMergeApprovals } from "@fusion/core";

const captureWorkspaceReviewEvidenceMock = vi.hoisted(() => vi.fn());
const isFastForwardAdvanceMock = vi.hoisted(() => vi.fn());

vi.mock("../worktree/workspace-review-evidence.js", () => ({
  captureWorkspaceReviewEvidence: captureWorkspaceReviewEvidenceMock,
}));
vi.mock("../worktree/review-inline-fix-recapture.js", () => ({
  isFastForwardAdvance: isFastForwardAdvanceMock,
}));

import { reviewWorkspacePerRepo } from "../executor/workspace-review-per-repo.js";

type Capture = {
  repositories: Array<{
    repository: string;
    baseCommitSha: string;
    branch: string;
    files: string[];
    qualifiedFiles: string[];
    fingerprint?: string;
    ahead: boolean;
    netZero: boolean;
  }>;
  modifiedFiles: string[];
  modifiedRepositories: Set<string>;
  outOfScopeRepositories: Set<string>;
};

const roots: string[] = [];

function capture(branch: string, fingerprint: string, file: string, outOfScopeRepositories = new Set<string>()): Capture {
  return {
    repositories: [{
      repository: "repo-a",
      baseCommitSha: "base-a",
      branch,
      files: [file],
      qualifiedFiles: [`repo-a/${file}`],
      fingerprint,
      ahead: true,
      netZero: false,
    }],
    modifiedFiles: [`repo-a/${file}`],
    modifiedRepositories: new Set(["repo-a"]),
    outOfScopeRepositories,
  };
}

function workspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-fn9234-workspace-review-"));
  roots.push(root);
  mkdirSync(join(root, "reviews", "repo-a"), { recursive: true });
  return root;
}

function taskFor(root: string): Task {
  return {
    id: "FN-9234",
    column: "in-review",
    repositoryScope: { state: "confirmed", revision: 4, repositories: ["repo-a"] },
    workspaceWorktrees: {
      "repo-a": {
        worktreePath: join(root, "reviews", "repo-a"),
        branch: "review-branch",
        baseCommitSha: "base-a",
      },
    },
  } as Task;
}

async function review(task: Task, root: string, verdict: "APPROVE" | "REVISE" = "APPROVE") {
  return reviewWorkspacePerRepo(task, async () => ({ verdict, review: verdict, summary: verdict }), {
    workspaceRepos: ["repo-a"],
    workspaceRootDir: root,
  });
}

afterEach(() => {
  captureWorkspaceReviewEvidenceMock.mockReset();
  isFastForwardAdvanceMock.mockReset();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("workspace inline-review fix evidence recapture", () => {
  it("publishes fresh fingerprint, modified files, and repository outcome after the reviewer fast-forwards its own repository", async () => {
    const root = workspaceRoot();
    const task = taskFor(root);
    captureWorkspaceReviewEvidenceMock.mockResolvedValueOnce(capture("before-review", "before-fingerprint", "src/old.ts"));
    captureWorkspaceReviewEvidenceMock.mockResolvedValueOnce(capture("after-inline-fix", "after-fingerprint", "src/fixed.ts"));
    isFastForwardAdvanceMock.mockResolvedValue(true);

    const result = await review(task, root);

    expect(isFastForwardAdvanceMock).toHaveBeenCalledWith(join(root, "reviews", "repo-a"), "before-review", "after-inline-fix");
    expect(result.repositoryDiffFingerprints).toEqual({ "repo-a": "after-fingerprint" });
    expect(result.repositoryModifiedFiles).toEqual(["repo-a/src/fixed.ts"]);
    expect(result.repositoryReviewOutcomes).toEqual([expect.objectContaining({
      repository: "repo-a",
      status: "REVIEWED",
      fingerprint: "after-fingerprint",
    })]);
  });

  it("does not credit a repository that became dirty without its own review", async () => {
    const root = workspaceRoot();
    mkdirSync(join(root, "reviews", "repo-b"), { recursive: true });
    const task = taskFor(root);
    task.repositoryScope = { state: "confirmed", revision: 4, repositories: ["repo-a", "repo-b"] };
    task.workspaceWorktrees!["repo-b"] = {
      worktreePath: join(root, "reviews", "repo-b"),
      branch: "review-branch-b",
      baseCommitSha: "base-b",
    };
    const cleanB = {
      repository: "repo-b", baseCommitSha: "base-b", branch: "before-review-b", files: [], qualifiedFiles: [],
      ahead: false, netZero: false,
    };
    const dirtyB = {
      repository: "repo-b", baseCommitSha: "base-b", branch: "after-review-b", files: ["src/new.ts"], qualifiedFiles: ["repo-b/src/new.ts"],
      fingerprint: "unreviewed-fingerprint", ahead: true, netZero: false,
    };
    captureWorkspaceReviewEvidenceMock.mockResolvedValueOnce({
      ...capture("before-review-a", "before-fingerprint", "src/old.ts"),
      repositories: [capture("before-review-a", "before-fingerprint", "src/old.ts").repositories[0], cleanB],
    });
    captureWorkspaceReviewEvidenceMock.mockResolvedValueOnce({
      ...capture("after-review-a", "after-fingerprint", "src/fixed.ts"),
      repositories: [capture("after-review-a", "after-fingerprint", "src/fixed.ts").repositories[0], dirtyB],
      modifiedFiles: ["repo-a/src/fixed.ts", "repo-b/src/new.ts"],
      modifiedRepositories: new Set(["repo-a", "repo-b"]),
    });
    isFastForwardAdvanceMock.mockResolvedValue(true);

    const result = await reviewWorkspacePerRepo(task, async () => ({ verdict: "APPROVE", review: "APPROVE", summary: "APPROVE" }), {
      workspaceRepos: ["repo-a", "repo-b"],
      workspaceRootDir: root,
    });

    expect(result.repositoryDiffFingerprints).toEqual({ "repo-a": "after-fingerprint" });
    expect(result.repositoryReviewOutcomes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ repository: "repo-b", status: "REVIEWED" }),
    ]));
    expect(isFastForwardAdvanceMock).toHaveBeenCalledTimes(1);
  });

  it("retains the original approval fingerprint when the post-review tip is not a fast-forward", async () => {
    const root = workspaceRoot();
    const task = taskFor(root);
    captureWorkspaceReviewEvidenceMock.mockResolvedValueOnce(capture("before-review", "before-fingerprint", "src/old.ts"));
    captureWorkspaceReviewEvidenceMock.mockResolvedValueOnce(capture("rewritten-tip", "rewritten-fingerprint", "src/rewrite.ts"));
    isFastForwardAdvanceMock.mockResolvedValue(false);

    const result = await review(task, root);

    expect(result.repositoryDiffFingerprints).toEqual({ "repo-a": "before-fingerprint" });
    expect(result.repositoryReviewOutcomes).toEqual([expect.objectContaining({ fingerprint: "before-fingerprint" })]);
  });

  it("does not re-capture evidence for a revising aggregate verdict", async () => {
    const root = workspaceRoot();
    const task = taskFor(root);
    captureWorkspaceReviewEvidenceMock.mockResolvedValueOnce(capture("before-review", "before-fingerprint", "src/old.ts"));

    const result = await review(task, root, "REVISE");

    expect(result.verdict).toBe("REVISE");
    expect(captureWorkspaceReviewEvidenceMock).toHaveBeenCalledTimes(1);
    expect(isFastForwardAdvanceMock).not.toHaveBeenCalled();
  });

  it("refuses approval when the post-review capture discovers out-of-scope work", async () => {
    const root = workspaceRoot();
    const task = taskFor(root);
    captureWorkspaceReviewEvidenceMock.mockResolvedValueOnce(capture("before-review", "before-fingerprint", "src/old.ts"));
    captureWorkspaceReviewEvidenceMock.mockResolvedValueOnce(capture("after-inline-fix", "after-fingerprint", "src/fixed.ts", new Set(["repo-outside-scope"])));
    isFastForwardAdvanceMock.mockResolvedValue(true);

    const result = await review(task, root);

    expect(result).toMatchObject({ verdict: "UNAVAILABLE", retryable: false });
    expect(result.repositoryDiffFingerprints).toBeUndefined();
  });

  it("provides one advanced evidence carrier that satisfies every workspace content-review row", async () => {
    const root = workspaceRoot();
    const task = taskFor(root);
    captureWorkspaceReviewEvidenceMock.mockResolvedValueOnce(capture("before-review", "before-fingerprint", "src/old.ts"));
    captureWorkspaceReviewEvidenceMock.mockResolvedValueOnce(capture("after-inline-fix", "after-fingerprint", "src/fixed.ts"));
    isFastForwardAdvanceMock.mockResolvedValue(true);

    const result = await review(task, root);
    task.repositoryScope = {
      ...task.repositoryScope!,
      reviewEvidence: {
        "repo-a": { fingerprint: result.repositoryDiffFingerprints!["repo-a"]!, approvedAt: "2026-09-01T00:00:00.000Z" },
      },
    };
    task.workflowStepResults = [
      { workflowStepId: "security-review", status: "passed", verdict: "APPROVE", reviewKind: "code", repositoryScopeRevision: 4 },
      { workflowStepId: "code-review", status: "passed", verdict: "APPROVE", reviewKind: "code", repositoryScopeRevision: 4 },
    ];

    expect(evaluatePreMergeApprovals(task, {
      requiredPreMergeStepIds: new Set(["security-review", "code-review"]),
      mergeContent: {
        kind: "workspace",
        repositories: {
          state: "available",
          inScopeModified: ["repo-a"],
          fingerprints: { "repo-a": "after-fingerprint" },
        },
      },
    })).toEqual([
      { workflowStepId: "security-review", state: "approved" },
      { workflowStepId: "code-review", state: "approved" },
    ]);
  });
});

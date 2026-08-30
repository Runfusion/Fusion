import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCodeReviewChangeSummaryBlock } from "../executor/execute-workflow-step.js";
import { buildReviewConvergenceContext } from "../executor/optional-step-revision.js";
import { probeReviewChangesSinceCommit } from "../worktree/review-diff-fingerprint.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("review changes since the previous reviewed commit", () => {
  let worktree: string;
  let reviewedCommitSha: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "fusion-review-changes-"));
    git(worktree, ["init", "-q"]);
    git(worktree, ["config", "user.email", "fusion@example.test"]);
    git(worktree, ["config", "user.name", "Fusion Test"]);
    writeFileSync(join(worktree, "first.txt"), "first\n");
    git(worktree, ["add", "first.txt"]);
    git(worktree, ["commit", "-qm", "initial"]);
    reviewedCommitSha = git(worktree, ["rev-parse", "HEAD"]);
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  function commitRemediation(): void {
    writeFileSync(join(worktree, "first.txt"), "first changed\n");
    writeFileSync(join(worktree, "second.txt"), "second\n");
    git(worktree, ["add", "first.txt", "second.txt"]);
    git(worktree, ["commit", "-qm", "remediate review"]);
  }

  function taskWithPriorAnchor(anchor: string | null = reviewedCommitSha, workspace = false) {
    return {
      ...(workspace ? { workspaceWorktrees: {} } : {}),
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge" as const,
        source: "optional-group" as const,
        status: "skipped" as const,
        priorAttempts: [{
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          phase: "pre-merge" as const,
          source: "optional-group" as const,
          status: "failed" as const,
          verdict: "REVISE" as const,
          findings: [{ id: "prior-finding", title: "Prior defect", body: "Keep the invariant." }],
          ...(anchor ? { reviewedCommitSha: anchor } : {}),
        }],
      }],
    };
  }

  it("returns unavailable for an unknown reviewed commit without throwing", async () => {
    await expect(probeReviewChangesSinceCommit(worktree, "not-a-commit")).resolves.toEqual({
      state: "unavailable",
      reason: "git-changes-since-review-failed",
    });
  });

  it("reports a frozen range when no commits landed after the reviewed commit", async () => {
    await expect(probeReviewChangesSinceCommit(worktree, reviewedCommitSha)).resolves.toEqual({
      state: "frozen",
      commitCount: 0,
    });
  });

  it("reports commit count, changed files, and shortstat for a populated range", async () => {
    commitRemediation();

    await expect(probeReviewChangesSinceCommit(worktree, reviewedCommitSha)).resolves.toEqual({
      state: "changed",
      commitCount: 1,
      changedFiles: ["first.txt", "second.txt"],
      totalChangedFileCount: 2,
      shortstat: "2 files changed, 2 insertions(+), 1 deletion(-)",
    });
  });

  it("omits the block on the first review attempt", async () => {
    await expect(buildCodeReviewChangeSummaryBlock({ workflowStepResults: [] }, "code-review", worktree)).resolves.toBeUndefined();
  });

  it("renders commits, files, and diff stat beneath the convergence heading", async () => {
    commitRemediation();
    const summary = await buildCodeReviewChangeSummaryBlock(taskWithPriorAnchor(), "code-review", worktree);
    const context = buildReviewConvergenceContext(taskWithPriorAnchor(), {
      revisionKey: "code-review",
      reviewKind: "code",
      changeSummaryBlock: summary,
    });

    expect(summary).toContain("1 commit landed since the commit reviewed in your previous round.");
    expect(summary).toContain("- first.txt");
    expect(summary).toContain("- second.txt");
    expect(summary).toContain("Diff stat: 2 files changed, 2 insertions(+), 1 deletion(-)");
    expect(context.indexOf("### Changed since your previous review")).toBeGreaterThan(context.indexOf("## Convergence"));
    expect(context.indexOf("### Changed since your previous review")).toBeLessThan(context.indexOf("Treat the cumulative prior feedback"));
    expect(context).toContain("### Your prior findings on this gate");
  });

  it("states that the tree is frozen and requires maintain-by-ID or approval", async () => {
    const summary = await buildCodeReviewChangeSummaryBlock(taskWithPriorAnchor(), "code-review", worktree);

    expect(summary).toContain("No commits landed since your previous review; the reviewed code is unchanged.");
    expect(summary).toContain("Maintain each prior finding by ID if it still applies, or approve.");
  });

  it("omits the block for legacy attempts without an anchor", async () => {
    await expect(buildCodeReviewChangeSummaryBlock(taskWithPriorAnchor(null), "code-review", worktree)).resolves.toBeUndefined();
  });

  it("omits the block when Git evidence is unavailable", async () => {
    await expect(buildCodeReviewChangeSummaryBlock(taskWithPriorAnchor("not-a-commit"), "code-review", worktree)).resolves.toBeUndefined();
  });

  it("omits the singular block for workspace review tasks", async () => {
    await expect(buildCodeReviewChangeSummaryBlock(taskWithPriorAnchor(reviewedCommitSha, true), "code-review", worktree)).resolves.toBeUndefined();
  });
});

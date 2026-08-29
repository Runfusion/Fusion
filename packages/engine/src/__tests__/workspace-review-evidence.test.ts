import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Task } from "@fusion/core";
import { captureWorkspaceReviewEvidence } from "../worktree/workspace-review-evidence.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf8" }).trim();
}

/** FNXC:WorkspaceReviewEvidence 2026-08-21-19:25: canonical evidence must measure branch refs, not a linked checkout's identical HEAD. */
describeIfGit("captureWorkspaceReviewEvidence", () => {
  let fixture: WorkspaceFixture;
  afterEach(() => fixture?.cleanup());

  it("captures the complete task-branch payload once while retaining a clean peer as no obligation", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const repository = fixture.repoPath("repo-a");
    const baseCommitSha = git(repository, "git rev-parse HEAD");
    const worktreePath = path.join(fixture.rootDir, "linked-a");
    git(repository, `git worktree add -b fusion/fn-evidence ${worktreePath} HEAD`);
    git(worktreePath, 'git config user.email "fusion@example.test"');
    git(worktreePath, 'git config user.name "Fusion"');
    writeFileSync(path.join(worktreePath, "same.ts"), "export const first = true;\n");
    git(worktreePath, "git add same.ts && git commit -m 'feat(FN-E): attributed work'");
    writeFileSync(path.join(worktreePath, "foreign.ts"), "export const foreign = true;\n");
    git(worktreePath, "git add foreign.ts && git commit -m 'foreign commit on task branch'");

    const task = {
      id: "FN-E",
      title: "evidence",
      description: "",
      column: "in-review",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      repositoryScope: { repositories: ["repo-a", "repo-b"], state: "confirmed", revision: 1 },
      workspaceWorktrees: {
        "repo-a": { worktreePath, branch: "fusion/fn-evidence", baseCommitSha },
        "repo-b": { worktreePath: fixture.repoPath("repo-b"), branch: "main", baseCommitSha: git(fixture.repoPath("repo-b"), "git rev-parse HEAD") },
      },
    } as Task;

    const evidence = await captureWorkspaceReviewEvidence({ task, workspaceRootDir: fixture.rootDir, settings: {} });
    expect(evidence.modifiedFiles).toEqual(["repo-a/foreign.ts", "repo-a/same.ts"]);
    expect(evidence.modifiedRepositories).toEqual(new Set(["repo-a"]));
    expect(evidence.outOfScopeRepositories).toEqual(new Set());
    expect(evidence.repositories.find((item) => item.repository === "repo-a")).toMatchObject({
      files: ["foreign.ts", "same.ts"], ahead: true, netZero: false, fingerprint: expect.any(String),
    });
    expect(evidence.repositories.find((item) => item.repository === "repo-b")).toMatchObject({
      files: [], ahead: false, netZero: false, fingerprint: undefined,
    });
  });
});

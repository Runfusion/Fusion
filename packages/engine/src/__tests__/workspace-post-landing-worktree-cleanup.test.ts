import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";
import { cleanupLandedWorkspaceTaskWorktrees } from "../merge/post-landing-worktree-cleanup.js";

const describeIfGit = hasGit ? describe : describe.skip;
const taskId = "FN-268";
let fixture: WorkspaceFixture | undefined;

afterEach(() => fixture?.cleanup());

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function addWorkspaceTaskWorktree(repoRel: string): { worktreePath: string; branch: string; landedSha: string } {
  const repoRoot = fixture!.repoPath(repoRel);
  const worktreePath = join(fixture!.rootDir, ".fusion", "worktrees", taskId.toLowerCase(), repoRel);
  const branch = `fusion/fn-268-${repoRel}`;
  mkdirSync(join(worktreePath, ".."), { recursive: true });
  git(repoRoot, `git worktree add -b ${JSON.stringify(branch)} ${JSON.stringify(worktreePath)} HEAD`);
  return { worktreePath, branch, landedSha: git(repoRoot, "git rev-parse HEAD") };
}

function store() {
  return {
    getSettings: async () => ({}),
    logEntry: async () => undefined,
  } as any;
}

describeIfGit("workspace post-landing worktree cleanup", () => {
  it("removes real clean workspace checkouts and their parent task directory", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const repoA = addWorkspaceTaskWorktree("repo-a");
    const repoB = addWorkspaceTaskWorktree("repo-b");
    const taskDir = join(fixture.rootDir, ".fusion", "worktrees", taskId.toLowerCase());

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store(),
      task: {
        id: taskId,
        workspaceWorktrees: {
          "repo-a": { worktreePath: repoA.worktreePath, branch: repoA.branch },
          "repo-b": { worktreePath: repoB.worktreePath, branch: repoB.branch },
        },
      } as any,
      workspaceRootDir: fixture.rootDir,
      landedShas: { "repo-a": repoA.landedSha, "repo-b": repoB.landedSha },
      source: "workspace-finalize-test",
    });

    expect(result).toEqual(expect.objectContaining({
      removedRepoRels: ["repo-a", "repo-b"],
      preserved: [],
      taskDirectoryRemoved: true,
      removed: true,
    }));
    expect(existsSync(repoA.worktreePath)).toBe(false);
    expect(existsSync(repoB.worktreePath)).toBe(false);
    expect(existsSync(taskDir)).toBe(false);
  });

  it("preserves deliverable content and leaves the task directory intact", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const repoA = addWorkspaceTaskWorktree("repo-a");
    const taskDir = join(fixture.rootDir, ".fusion", "worktrees", taskId.toLowerCase());
    writeFileSync(join(repoA.worktreePath, "deliverable.txt"), "keep me\n");

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store(),
      task: { id: taskId, workspaceWorktrees: { "repo-a": { worktreePath: repoA.worktreePath, branch: repoA.branch } } } as any,
      workspaceRootDir: fixture.rootDir,
      landedShas: { "repo-a": repoA.landedSha },
      source: "workspace-finalize-test",
    });

    expect(result).toEqual(expect.objectContaining({ taskDirectoryRemoved: false, removed: false }));
    expect(result.preserved).toEqual([expect.objectContaining({ repoRel: "repo-a", reason: "deliverable" })]);
    expect(existsSync(repoA.worktreePath)).toBe(true);
    expect(existsSync(taskDir)).toBe(true);
  });
});

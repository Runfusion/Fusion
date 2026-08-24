/*
FNXC:Workspace 2026-06-21-12:00:
Shared REAL two-repo git fixture for workspace-mode engine tests (U1 + U2 + later phases). The foundation's executor-workspace test self-mocked the functions under test, which proves nothing; this harness instead builds genuine on-disk git repos under a NON-git workspace root so that any leaked rootDir git preflight actually fails. U2 and later units import `createWorkspaceFixture` directly — keep it dependency-light (only node:child_process + node:fs + saveWorkspaceConfig).

A workspace root is a plain directory (NOT a git repo) containing N sub-repos. Each sub-repo is a real git repo with an initial commit on a default branch. `<root>/.fusion/workspace.json` lists the sub-repo relative paths so `loadWorkspaceConfig(root)` returns a populated config — the exact signal `this.workspaceConfig` keys off in the executor.
*/
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveWorkspaceConfig } from "@fusion/core";

export const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Initialize a real git repo at `repoDir` with one commit on `defaultBranch`. */
export function initRepoWithCommit(repoDir: string, defaultBranch = "main"): void {
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, `git init -b ${defaultBranch}`);
  git(repoDir, 'git config user.email "test@example.com"');
  git(repoDir, 'git config user.name "Test"');
  writeFileSync(path.join(repoDir, "README.md"), `# ${path.basename(repoDir)}\n`, "utf-8");
  git(repoDir, "git add README.md");
  // FNXC:Workspace 2026-08-15-07:05: Fixture initialization predates task anchors, so completion guards can distinguish operator baseline commits from task-era bypass commits.
  git(repoDir, "GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' git commit -m 'init'");
}

export interface WorkspaceFixture {
  /** Absolute path to the non-git workspace root. */
  rootDir: string;
  /** Relative sub-repo paths (workspace.json `repos`). */
  repos: string[];
  /** Absolute path to a sub-repo by relative name. */
  repoPath(rel: string): string;
  /** Run a git command inside a sub-repo. */
  git(rel: string, command: string): string;
  /** Create a live linked task worktree and capture its immutable acquisition baseline. */
  createLinkedTaskWorktree(rel: string, branch: string): { worktreePath: string; baseCommitSha: string };
  /** Remove all on-disk fixture state. */
  cleanup(): void;
}

/**
 * Create a real two-repo (by default) workspace fixture on disk.
 * - `rootDir` is a plain non-git directory.
 * - Each `repos[i]` is a real git repo with an initial commit.
 * - `<root>/.fusion/workspace.json` is written so loadWorkspaceConfig() resolves.
 */
export async function createWorkspaceFixture(
  repos: string[] = ["repo-a", "repo-b"],
  defaultBranch = "main",
): Promise<WorkspaceFixture> {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "fusion-workspace-"));
  for (const rel of repos) {
    initRepoWithCommit(path.join(rootDir, rel), defaultBranch);
  }
  await saveWorkspaceConfig(rootDir, { repos });

  return {
    rootDir,
    repos,
    repoPath: (rel: string) => path.join(rootDir, rel),
    git: (rel: string, command: string) => git(path.join(rootDir, rel), command),
    /*
    FNXC:WorkspaceMergeEvidence 2026-08-21-17:33:
    FN-112 needs real-Git coverage where the persisted path is the live task worktree and HEAD
    equals its task branch. Main-checkout stand-ins hid the invalid self-comparison that erased
    merge evidence, so this fixture captures the acquisition baseline before the task commit.
    */
    createLinkedTaskWorktree: (rel: string, branch: string) => {
      const repoDir = path.join(rootDir, rel);
      const worktreePath = path.join(rootDir, `.task-worktree-${rel.replace(/[^a-z0-9]+/gi, "-")}`);
      const baseCommitSha = git(repoDir, "git rev-parse HEAD");
      git(repoDir, `git worktree add -b ${branch} ${worktreePath} HEAD`);
      return { worktreePath, baseCommitSha };
    },
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

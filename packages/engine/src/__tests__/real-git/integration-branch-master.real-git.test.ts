import { afterEach, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectBranchConflict } from "../../execution/branch-conflicts.js";
import { resolveIntegrationBranch } from "../../merge/integration-branch.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

describeIfGit("integration branch resolution (real git, master)", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  function setupRepo(): string {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-5349-"));
    repos.push(repo);
    git(repo, "git init -b master");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test"');
    git(repo, "git commit --allow-empty -m 'init'");
    git(repo, "git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master");
    return repo;
  }

  it("resolves origin/HEAD and respects explicit override", async () => {
    const repo = setupRepo();
    await expect(resolveIntegrationBranch(repo, {})).resolves.toBe("master");
    await expect(resolveIntegrationBranch(repo, { integrationBranch: "trunk" })).resolves.toBe("trunk");
  });

  it("inspects branch conflicts against master without disturbing dirty root worktree", async () => {
    const repo = setupRepo();
    git(repo, "git checkout -b fusion/fn-5349-check");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "task.txt"), "task\n", "utf-8");
    git(repo, "git add src/task.txt && git commit -m 'task change'");
    git(repo, "git checkout master");

    const conflictWorktree = path.join(repo, ".worktrees", "fn-5349-check");
    mkdirSync(path.dirname(conflictWorktree), { recursive: true });
    git(repo, `git worktree add ${JSON.stringify(conflictWorktree)} fusion/fn-5349-check`);

    writeFileSync(path.join(repo, "dirty.txt"), "dirty\n", "utf-8");
    writeFileSync(path.join(repo, "untracked.txt"), "untracked\n", "utf-8");
    const preStatus = git(repo, "git status --short");

    const result = await inspectBranchConflict({
      repoDir: repo,
      branchName: "fusion/fn-5349-check",
      conflictingWorktreePath: conflictWorktree,
      requestingTaskId: "FN-5349",
      ownerTaskId: "FN-5349",
      startPoint: "master",
      integrationRef: "master",
    });

    expect(["reclaimable", "live-foreign", "fully-subsumed", "tip-already-merged"]).toContain(result.kind);
    expect(git(repo, "git symbolic-ref --short HEAD")).toBe("master");
    expect(readFileSync(path.join(repo, "dirty.txt"), "utf-8")).toBe("dirty\n");
    expect(readFileSync(path.join(repo, "untracked.txt"), "utf-8")).toBe("untracked\n");
    expect(git(repo, "git status --short")).toBe(preStatus);
  });
});

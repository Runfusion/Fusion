import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCapturedBaseCommitSha } from "../base-commit-capture.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

describeIfGit("resolveCapturedBaseCommitSha real-git scenarios", { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function originFixture(): string {
    const origin = tmp("fusion-base-capture-origin-");
    git(origin, "git init -b main");
    git(origin, 'git config user.email "test@example.com"');
    git(origin, 'git config user.name "Test User"');
    writeFileSync(join(origin, "README.md"), "init\n");
    git(origin, "git add README.md && git commit -m 'init'");
    return origin;
  }

  function cloneFixture(origin: string): string {
    const clone = tmp("fusion-base-capture-clone-");
    git(clone, `git clone ${JSON.stringify(origin)} .`);
    git(clone, 'git config user.email "test@example.com"');
    git(clone, 'git config user.name "Test User"');
    return clone;
  }

  it("captures the local-main fork point when local main is ahead of origin/main (unpushed merges)", async () => {
    // Models the FN-5937 regression: the merger lands other tasks' commits on
    // LOCAL main first; new task branches fork from that tip before the
    // rebase-and-push rewrites those SHAs. Capturing merge-base against
    // origin/main rewinds past the unpushed merges, so the dashboard diff
    // (baseCommitSha..HEAD) later surfaces the predecessors' files as this
    // task's "files changed".
    const origin = originFixture();
    const clone = cloneFixture(origin);

    // Local main advances by a merged-but-unpushed predecessor task commit.
    writeFileSync(join(clone, "predecessor.txt"), "FN-5936 work\n");
    git(clone, "git add predecessor.txt && git commit -m 'FN-5936: predecessor task'");
    const localMainTip = git(clone, "git rev-parse HEAD");

    // New task branch forks from local main (prepareForTask behavior).
    git(clone, "git checkout -B fusion/fn-5937-test main");

    const captured = await resolveCapturedBaseCommitSha(clone);
    expect(captured).toBe(localMainTip);
  });

  it("captures the merge-base with main for a branch with its own commits", async () => {
    const origin = originFixture();
    const clone = cloneFixture(origin);
    const forkPoint = git(clone, "git rev-parse HEAD");

    git(clone, "git checkout -B fusion/fn-100-test main");
    writeFileSync(join(clone, "feature.txt"), "feature\n");
    git(clone, "git add feature.txt && git commit -m 'FN-100: feature'");

    const captured = await resolveCapturedBaseCommitSha(clone);
    expect(captured).toBe(forkPoint);
  });

  it("falls back to origin/main when no local main branch exists", async () => {
    const origin = originFixture();
    const clone = cloneFixture(origin);
    const originMainSha = git(clone, "git rev-parse origin/main");

    // Detach and delete local main so only origin/main can resolve.
    git(clone, "git checkout --detach origin/main");
    git(clone, "git branch -D main");
    git(clone, "git checkout -B fusion/fn-200-test");

    const captured = await resolveCapturedBaseCommitSha(clone);
    expect(captured).toBe(originMainSha);
  });

  it("falls back to HEAD when neither main nor origin/main resolves", async () => {
    const repo = tmp("fusion-base-capture-nomain-");
    git(repo, "git init -b trunk");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    writeFileSync(join(repo, "README.md"), "init\n");
    git(repo, "git add README.md && git commit -m 'init'");
    const head = git(repo, "git rev-parse HEAD");

    const captured = await resolveCapturedBaseCommitSha(repo);
    expect(captured).toBe(head);
  });
});

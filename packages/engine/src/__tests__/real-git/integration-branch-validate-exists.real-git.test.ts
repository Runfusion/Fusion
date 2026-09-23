import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isUsableBranchName, resolveIntegrationBranch, resolveIntegrationBranchSync } from "../../merge/integration-branch.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

/**
 * Parity pin for the pure-JS branch-name validator against real git:
 * for every probe name, isUsableBranchName must agree with
 * `git check-ref-format --branch` AND with whether `git branch -- <name> HEAD`
 * actually accepts the name. Git rejects check-ref-format violations even with
 * `--` (it only disambiguates options), so creation is the ground truth consumers
 * hit — see the BUG-0001/BUG-0002 comments in integration-branch-validate-exists.test.ts.
 */
const VALID_NAMES = [
  "master",
  "trunk",
  "@",
  "@@",
  "a/@",
  "V1.0",
  "a_b-c",
  "HEAD-x",
  "a.b",
  "feature/x",
  "a;b", // shell-hostile but legal refname
  "a&b",
  "x9",
  "feature/long_name.with-dots",
];

const INVALID_NAMES = [
  "HEAD", // reserved
  "-m", // option-like
  "-x",
  "a b", // space
  "a~b",
  "a^b",
  "a:b",
  "a?b",
  "a*b",
  "a[b",
  "a\\b",
  "a..b",
  ".a", // leading dot
  "a.", // trailing dot
  "a.lock", // .lock suffix
  "a@{b}", // @{ sequence
  "a//b", // double slash
  "/a", // leading slash
  "a/", // trailing slash
  "head@{1}", // @{ sequence inside a plausible name
  "", // empty
];

describeIfGit("integration branch name validation (real git parity)", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  function setupRepo(): string {
    const repo = mkdtempSync(path.join(os.tmpdir(), "integration-branch-namecheck-"));
    repos.push(repo);
    const run = (args: string[]) => spawnSync("git", args, { cwd: repo, stdio: "pipe" });
    run(["init", "-b", "master"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    run(["commit", "--allow-empty", "-m", "init"]);
    run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"]);
    return repo;
  }

  it("agrees with git check-ref-format and git branch creation for every probe name", () => {
    const repo = setupRepo();
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, stdio: "pipe" }).stdout.toString().trim();

    for (const name of VALID_NAMES) {
      const formatStatus = spawnSync("git", ["check-ref-format", "--branch", name], { stdio: "pipe" }).status;
      expect(formatStatus, `check-ref-format --branch should accept ${JSON.stringify(name)}`).toBe(0);
      expect(isUsableBranchName(name), `validator should accept ${JSON.stringify(name)}`).toBe(true);
      // `master` already exists (init -b master): creation would fail for the wrong
      // reason, so only assert it when the branch is actually missing.
      const exists = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${name}`], { cwd: repo, stdio: "pipe" }).status === 0;
      if (!exists) {
        const created = spawnSync("git", ["branch", "--", name, head], { cwd: repo, stdio: "pipe" });
        expect(created.status, `git branch -- ${JSON.stringify(name)} should succeed`).toBe(0);
        spawnSync("git", ["branch", "-D", "--", name], { cwd: repo, stdio: "pipe" });
      }
    }

    for (const name of INVALID_NAMES) {
      const formatStatus = spawnSync("git", ["check-ref-format", "--branch", name], { stdio: "pipe" }).status;
      expect(formatStatus, `check-ref-format --branch should reject ${JSON.stringify(name)}`).not.toBe(0);
      expect(isUsableBranchName(name), `validator should reject ${JSON.stringify(name)}`).toBe(false);
      const created = spawnSync("git", ["branch", "--", name, head], { cwd: repo, stdio: "pipe" });
      expect(created.status, `git branch -- ${JSON.stringify(name)} should fail`).not.toBe(0);
    }
  });

  it("falls through a configured candidate git rejects (HEAD) to baseBranch (async)", async () => {
    // BUG-0002 end to end: refs/remotes/origin/HEAD exists (normal clone), so the old
    // existence probe accepted the configured candidate "HEAD"; materializing it with
    // `git branch HEAD <ref>` then failed and the ladder aborted instead of reaching
    // baseBranch. The validator must reject the candidate before any probe, and the
    // resolver must return baseBranch without creating refs/heads/HEAD.
    const repo = setupRepo();
    const resolved = await resolveIntegrationBranch(repo, { integrationBranch: "HEAD", baseBranch: "master" });
    expect(resolved).toBe("master");
    expect(spawnSync("git", ["rev-parse", "--verify", "-q", "refs/heads/HEAD"], { cwd: repo, stdio: "pipe" }).status).not.toBe(0);
  });

  it("falls through a configured candidate git rejects (HEAD) to baseBranch (sync)", () => {
    const repo = setupRepo();
    const resolved = resolveIntegrationBranchSync(repo, { integrationBranch: "HEAD", baseBranch: "master" });
    expect(resolved).toBe("master");
    expect(spawnSync("git", ["rev-parse", "--verify", "-q", "refs/heads/HEAD"], { cwd: repo, stdio: "pipe" }).status).not.toBe(0);
  });
});

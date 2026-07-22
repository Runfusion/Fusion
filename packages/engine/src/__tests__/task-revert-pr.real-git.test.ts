import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRevertPrBranch } from "../execution/task-revert.js";
import type { Task } from "@fusion/core";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-A",
    lineageId: "FN-A",
    description: "",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    ...overrides,
  } as Task;
}

// FN-7554: real-git regression coverage for the PR-based revert branch-prep
// helper — clean → dedicated branch (base never mutated), conflicting/
// already-reverted/unsupported pass-through, idempotent local branch reset,
// and dirty-tree refusal.
describeIfGit("prepareRevertPrBranch real-git scenarios", { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repoFixture() {
    const repo = mkdtempSync(join(tmpdir(), "kb-revert-pr-"));
    dirs.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git config commit.gpgsign false");
    writeFileSync(join(repo, "foo.ts"), "line1\n");
    git(repo, "git add foo.ts && git commit -m 'init'");
    return repo;
  }

  it("clean → eligible: creates fusion/revert-<id> branch with revert commit, base untouched", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-A): add feature a'");
    const sha = git(repo, "git rev-parse HEAD");
    const mainHeadBefore = git(repo, "git rev-parse main");

    const task = makeTask({ mergeDetails: { commitSha: sha, mergeTargetBranch: "main" } });
    const result = await prepareRevertPrBranch({
      task,
      worktreePath: repo,
      baseBranch: "main",
      revertBranch: "fusion/revert-fn-a",
    });

    expect(result).toMatchObject({ eligible: true, revertBranch: "fusion/revert-fn-a" });
    if (result.eligible) {
      expect(result.revertCommitShas.length).toBe(1);
    }

    // (a) revert branch exists, tip is a revert(FN-A): commit carrying the trailer.
    const branchTipSubject = git(repo, "git log -1 --format=%s fusion/revert-fn-a");
    expect(branchTipSubject).toMatch(/^revert\(FN-A\):/);
    const branchTipBody = git(repo, "git log -1 --format=%B fusion/revert-fn-a");
    expect(branchTipBody).toContain("Fusion-Task-Id: FN-A");
    expect(git(repo, "git show fusion/revert-fn-a:foo.ts")).toBe("line1");

    // (b) main HEAD is byte-identical to before the call — base never written.
    expect(git(repo, "git rev-parse main")).toBe(mainHeadBefore);

    // (c) checkout restored to main and clean.
    expect(git(repo, "git rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(git(repo, "git status --porcelain")).toBe("");
  });

  it("conflicting → pass-through: no revert branch left behind, base + checkout unchanged", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-A): add feature a'");
    const shaA = git(repo, "git rev-parse HEAD");

    // Task B later modifies the exact same region touched by task A.
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a-modified-by-b\n");
    git(repo, "git commit -am 'feat(FN-B): modify same region'");

    const mainHeadBefore = git(repo, "git rev-parse main");
    const statusBefore = git(repo, "git status --porcelain");

    const task = makeTask({ mergeDetails: { commitSha: shaA, mergeTargetBranch: "main" } });
    const result = await prepareRevertPrBranch({
      task,
      worktreePath: repo,
      baseBranch: "main",
      revertBranch: "fusion/revert-fn-a",
    });

    expect(result).toMatchObject({ eligible: false, classification: "conflicting" });
    if (!result.eligible && result.classification === "conflicting") {
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts.some((c) => c.file === "foo.ts")).toBe(true);
    }

    const branchList = git(repo, "git branch --list fusion/revert-fn-a");
    expect(branchList).toBe("");
    expect(git(repo, "git rev-parse main")).toBe(mainHeadBefore);
    expect(git(repo, "git rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(git(repo, "git status --porcelain")).toBe(statusBefore);
  });

  it("already-reverted → pass-through: no branch, base unchanged", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-A): add feature a'");
    const sha = git(repo, "git rev-parse HEAD");

    // Manually revert the change on main before calling prepareRevertPrBranch.
    git(repo, `git revert --no-edit ${sha}`);
    const mainHeadBefore = git(repo, "git rev-parse main");

    const task = makeTask({ mergeDetails: { commitSha: sha, mergeTargetBranch: "main" } });
    const result = await prepareRevertPrBranch({
      task,
      worktreePath: repo,
      baseBranch: "main",
      revertBranch: "fusion/revert-fn-a",
    });

    expect(result).toMatchObject({ eligible: false, classification: "already-reverted", alreadyReverted: true });
    const branchList = git(repo, "git branch --list fusion/revert-fn-a");
    expect(branchList).toBe("");
    expect(git(repo, "git rev-parse main")).toBe(mainHeadBefore);
    expect(git(repo, "git rev-parse --abbrev-ref HEAD")).toBe("main");
  });

  it("workspace unsupported: a task with workspaceWorktrees populated is refused", async () => {
    const repo = repoFixture();
    const task = makeTask({
      workspaceWorktrees: { "repo-a": { worktreePath: "/tmp/whatever", branch: "main" } },
    });
    const result = await prepareRevertPrBranch({
      task,
      worktreePath: repo,
      baseBranch: "main",
      revertBranch: "fusion/revert-fn-a",
    });
    expect(result).toMatchObject({ eligible: false, unsupported: true, reason: "workspace-task-pr-revert-unsupported" });
  });

  it("idempotent local branch reset: a stale local branch pointing elsewhere is reset off base with the fresh revert commit", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-A): add feature a'");
    const sha = git(repo, "git rev-parse HEAD");

    // Pre-create a stale local branch pointing at an unrelated commit.
    git(repo, "git branch fusion/revert-fn-a main~1");
    const staleTip = git(repo, "git rev-parse fusion/revert-fn-a");
    expect(staleTip).not.toBe(git(repo, "git rev-parse main"));

    const task = makeTask({ mergeDetails: { commitSha: sha, mergeTargetBranch: "main" } });
    const result = await prepareRevertPrBranch({
      task,
      worktreePath: repo,
      baseBranch: "main",
      revertBranch: "fusion/revert-fn-a",
    });

    expect(result).toMatchObject({ eligible: true });
    const branchTipSubject = git(repo, "git log -1 --format=%s fusion/revert-fn-a");
    expect(branchTipSubject).toMatch(/^revert\(FN-A\):/);
    expect(git(repo, "git rev-parse --abbrev-ref HEAD")).toBe("main");
  });

  it("dirty-tree refusal: a stray staged change is refused without any branch/base mutation", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-A): add feature a'");
    const sha = git(repo, "git rev-parse HEAD");

    writeFileSync(join(repo, "stray.txt"), "stray change\n");
    git(repo, "git add stray.txt");

    const mainHeadBefore = git(repo, "git rev-parse main");
    const preStatus = git(repo, "git status --porcelain");

    const task = makeTask({ mergeDetails: { commitSha: sha, mergeTargetBranch: "main" } });
    await expect(
      prepareRevertPrBranch({ task, worktreePath: repo, baseBranch: "main", revertBranch: "fusion/revert-fn-a" }),
    ).rejects.toThrow();

    const branchList = git(repo, "git branch --list fusion/revert-fn-a");
    expect(branchList).toBe("");
    expect(git(repo, "git rev-parse main")).toBe(mainHeadBefore);
    expect(git(repo, "git status --porcelain")).toBe(preStatus);
  });
});

import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyTaskRevert,
  performTaskRevert,
  resolveTaskRevertCommits,
  TaskRevertError,
} from "../task-revert.js";
import type { Task, TaskCommitAssociation } from "@fusion/core";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-901",
    lineageId: "FN-901",
    description: "",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    ...overrides,
  } as Task;
}

// FN-7523: real-git regression coverage for the intelligent revert service —
// attribution resolution, dry-run classification (already-reverted/clean/conflicting),
// clean-apply commit creation, guaranteed-clean rollback, and guard rails.
describeIfGit("task-revert real-git scenarios", { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repoFixture() {
    const repo = mkdtempSync(join(tmpdir(), "fn-7523-revert-"));
    dirs.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git config commit.gpgsign false");
    writeFileSync(join(repo, "foo.ts"), "line1\n");
    git(repo, "git add foo.ts && git commit -m 'init'");
    return repo;
  }

  it("attribution: squash task resolves the single commitSha", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-901): add feature a'");
    const sha = git(repo, "git rev-parse HEAD");

    const task = makeTask({ mergeDetails: { commitSha: sha } });
    const resolved = await resolveTaskRevertCommits(task, { worktreePath: repo });
    expect(resolved.supported).toBe(true);
    if (resolved.supported) {
      expect(resolved.shas).toEqual([sha]);
      expect(resolved.source).toBe("squash");
    }
  });

  it("attribution: rebase task resolves the attributable subset by trailer", async () => {
    const repo = repoFixture();
    const rebaseBase = git(repo, "git rev-parse HEAD");
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git commit -am 'feat(FN-901): part 1'");
    writeFileSync(join(repo, "other.ts"), "unrelated\n");
    git(repo, "git add other.ts && git commit -m 'chore: unrelated foreign commit'");
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\nfeature-a-more\n");
    git(repo, "git commit -am 'more work' -m 'Fusion-Task-Id: FN-901'");
    const head = git(repo, "git rev-parse HEAD");

    const task = makeTask({ mergeDetails: { commitSha: head, rebaseBaseSha: rebaseBase } });
    const resolved = await resolveTaskRevertCommits(task, { worktreePath: repo });
    expect(resolved.supported).toBe(true);
    if (resolved.supported) {
      expect(resolved.shas.length).toBe(2);
      expect(resolved.source).toBe("rebase");
    }
  });

  it("attribution: lineage fallback used when mergeDetails absent", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-901): add feature a'");
    const sha = git(repo, "git rev-parse HEAD");

    const task = makeTask({ mergeDetails: undefined });
    const associations: TaskCommitAssociation[] = [
      {
        id: "assoc-1",
        taskLineageId: "FN-901",
        taskIdSnapshot: "FN-901",
        commitSha: sha,
        commitSubject: "feat(FN-901): add feature a",
        authoredAt: new Date().toISOString(),
        matchedBy: "canonical-lineage-trailer",
        confidence: "canonical",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const resolved = await resolveTaskRevertCommits(task, {
      worktreePath: repo,
      commitAssociationSource: {
        getTaskCommitAssociationsByLineageId: async () => associations,
      },
    });
    expect(resolved.supported).toBe(true);
    if (resolved.supported) {
      expect(resolved.shas).toEqual([sha]);
      expect(resolved.source).toBe("lineage");
    }
  });

  it("workspace unsupported: task with workspaceLandedShas is rejected", async () => {
    const repo = repoFixture();
    const task = makeTask({
      mergeDetails: { commitSha: "deadbeef", workspaceLandedShas: { "repo-a": "deadbeef" } },
    });
    const resolved = await resolveTaskRevertCommits(task, { worktreePath: repo });
    expect(resolved.supported).toBe(false);
    if (!resolved.supported) {
      expect(resolved.reason).toBe("workspace-task-revert-unsupported");
    }
  });

  it("clean revert: creates a revert(FN-xxxx) commit with Fusion-Task-Id trailer and reverts file content", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-901): add feature a'");
    const sha = git(repo, "git rev-parse HEAD");

    const task = makeTask({ column: "done", mergeDetails: { commitSha: sha, mergeTargetBranch: "main" } });
    const result = await performTaskRevert({ task, worktreePath: repo, baseBranch: "main" });
    expect(result).toMatchObject({ mode: "git", clean: true });
    if (result.mode === "git" && result.clean && "revertCommitSha" in result) {
      expect(result.revertCommitSha).toBeTruthy();
    }

    const log = git(repo, "git log -1 --format=%s%n%B");
    expect(log).toMatch(/^revert\(FN-901\):/);
    const fullBody = git(repo, "git log -1 --format=%B");
    expect(fullBody).toContain("Fusion-Task-Id: FN-901");

    const content = git(repo, "git show HEAD:foo.ts");
    expect(content).toBe("line1");

    const status = git(repo, "git status --porcelain");
    expect(status).toBe("");
  });

  it("conflict detection: a later task touching the same region classifies as conflicting and leaves tree+HEAD untouched", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-901): add feature a'");
    const shaA = git(repo, "git rev-parse HEAD");

    // Task B later modifies the exact same region touched by task A.
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a-modified-by-b\n");
    git(repo, "git commit -am 'feat(FN-902): modify same region'");

    const preCallHead = git(repo, "git rev-parse HEAD");
    const preCallStatus = git(repo, "git status --porcelain");

    const task = makeTask({ id: "FN-901", column: "done", mergeDetails: { commitSha: shaA, mergeTargetBranch: "main" } });
    const result = await performTaskRevert({ task, worktreePath: repo, baseBranch: "main" });

    expect(result).toMatchObject({ mode: "git", clean: false });
    if (result.mode === "git" && !result.clean && "conflicts" in result) {
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts.some((c) => c.file === "foo.ts")).toBe(true);
    }

    const postCallHead = git(repo, "git rev-parse HEAD");
    const postCallStatus = git(repo, "git status --porcelain");
    expect(postCallHead).toBe(preCallHead);
    expect(postCallStatus).toBe(preCallStatus);
    expect(postCallStatus).toBe("");
  });

  it("already-reverted / no-op: reverting a task twice reports alreadyReverted without a second commit", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-901): add feature a'");
    const sha = git(repo, "git rev-parse HEAD");

    const task = makeTask({ column: "done", mergeDetails: { commitSha: sha, mergeTargetBranch: "main" } });
    const first = await performTaskRevert({ task, worktreePath: repo, baseBranch: "main" });
    expect(first).toMatchObject({ mode: "git", clean: true });

    const headAfterFirst = git(repo, "git rev-parse HEAD");
    const second = await performTaskRevert({ task, worktreePath: repo, baseBranch: "main" });
    expect(second).toMatchObject({ mode: "git", clean: true, alreadyReverted: true });

    const headAfterSecond = git(repo, "git rev-parse HEAD");
    expect(headAfterSecond).toBe(headAfterFirst);
  });

  it("dirty-tree refusal: refuses without mutating the tree when a stray change is staged", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-901): add feature a'");
    const sha = git(repo, "git rev-parse HEAD");

    writeFileSync(join(repo, "stray.txt"), "stray change\n");
    git(repo, "git add stray.txt");

    const preStatus = git(repo, "git status --porcelain");
    await expect(classifyTaskRevert({ worktreePath: repo, commits: [sha] })).rejects.toThrow(TaskRevertError);
    const postStatus = git(repo, "git status --porcelain");
    expect(postStatus).toBe(preStatus);
  });

  it("guard rails: a non-done/archived task is rejected and the source task's column is unaffected", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-901): add feature a'");
    const sha = git(repo, "git rev-parse HEAD");

    const task = makeTask({ column: "in-progress", mergeDetails: { commitSha: sha, mergeTargetBranch: "main" } });
    const result = await performTaskRevert({ task, worktreePath: repo, baseBranch: "main" });
    expect(result).toMatchObject({ mode: "git", needsHuman: true });
    // Column is a property of the caller-owned task object, not mutated by the service.
    expect(task.column).toBe("in-progress");
  });

  it("guard rails: autoMerge:false returns a needsHuman result instead of force-writing", async () => {
    const repo = repoFixture();
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-901): add feature a'");
    const sha = git(repo, "git rev-parse HEAD");
    const preHead = git(repo, "git rev-parse HEAD");

    const task = makeTask({ column: "done", autoMerge: false, mergeDetails: { commitSha: sha, mergeTargetBranch: "main" } });
    const result = await performTaskRevert({ task, worktreePath: repo, baseBranch: "main" });
    expect(result).toMatchObject({ mode: "git", needsHuman: true });
    expect(git(repo, "git rev-parse HEAD")).toBe(preHead);
  });
});

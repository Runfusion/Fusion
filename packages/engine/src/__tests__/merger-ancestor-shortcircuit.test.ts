import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { commitOrAmendMergeWithFixes } from "../merger.js";
import { DEFAULT_SETTINGS } from "@fusion/core";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function initRepo(dir: string): void {
  git(dir, "git init -b main");
  git(dir, 'git config user.email "test@example.com"');
  git(dir, 'git config user.name "Test"');
  git(dir, "git config commit.gpgsign false");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "git add README.md");
  git(dir, 'git commit -m "chore: initial"');
}

function testTempParent(): string {
  return process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
}

function assertIsolatedWorkspace(dir: string): void {
  const repoRoot = process.env.FUSION_TEST_REAL_ROOT;
  if (!repoRoot) return;
  expect(resolve(dir).startsWith(resolve(repoRoot))).toBe(false);
}

function runFinalize(dir: string, taskId: string, branch: string, preAttemptHeadSha: string) {
  return commitOrAmendMergeWithFixes(
    dir,
    taskId,
    branch,
    "- test",
    false,
    preAttemptHeadSha,
    "",
    undefined,
    {
      ...DEFAULT_SETTINGS,
      commitAuthorEnabled: false,
    },
    undefined,
    null,
    null,
    new Set<string>(),
  );
}

describe("commitOrAmendMergeWithFixes ancestor/equivalent-content short-circuit", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(testTempParent(), "fusion-test-merger-ancestor-"));
    assertIsolatedWorkspace(dir);
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns success when HEAD already carries the task trailer", async () => {
    git(dir, "git checkout -b task");
    writeFileSync(join(dir, "foo.txt"), "from task\n");
    git(dir, "git add foo.txt");
    git(dir, 'git commit -m "feat: task commit\n\nFusion-Task-Id: FN-TEST"');
    const taskTip = git(dir, "git rev-parse HEAD");

    git(dir, "git checkout main");
    git(dir, `git merge --ff-only ${taskTip}`);
    const preAttemptHeadSha = git(dir, "git rev-parse HEAD");

    const result = await runFinalize(dir, "FN-TEST", "task", preAttemptHeadSha);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("head-task-trailer");
  });

  it("returns success when branch is already ancestor but HEAD belongs to another task", async () => {
    git(dir, "git checkout -b task");
    writeFileSync(join(dir, "foo.txt"), "from task\n");
    git(dir, "git add foo.txt");
    git(dir, 'git commit -m "feat: task commit\n\nFusion-Task-Id: FN-TEST"');
    const taskTip = git(dir, "git rev-parse HEAD");

    git(dir, "git checkout main");
    git(dir, `git merge --ff-only ${taskTip}`);
    writeFileSync(join(dir, "other.txt"), "other\n");
    git(dir, "git add other.txt");
    git(dir, 'git commit -m "feat: other commit\n\nFusion-Task-Id: FN-OTHER"');
    const preAttemptHeadSha = git(dir, "git rev-parse HEAD");

    const result = await runFinalize(dir, "FN-TEST", "task", preAttemptHeadSha);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("branch-already-merged");
  });

  it("returns success when branch content is already on main under a different SHA", async () => {
    git(dir, "git checkout -b task");
    writeFileSync(join(dir, "foo.txt"), "same-content\n");
    git(dir, "git add foo.txt");
    git(dir, 'git commit -m "feat: task commit\n\nFusion-Task-Id: FN-3846"');

    git(dir, "git checkout main");
    writeFileSync(join(dir, "foo.txt"), "same-content\n");
    git(dir, "git add foo.txt");
    git(dir, 'git commit -m "feat: same content other sha\n\nFusion-Task-Id: FN-OTHER"');
    const preAttemptHeadSha = git(dir, "git rev-parse HEAD");

    const result = await runFinalize(dir, "FN-3846", "task", preAttemptHeadSha);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("branch-already-merged");
  });

  it("still refuses real phantom finalize when no current-task branch content exists", async () => {
    writeFileSync(join(dir, "other.txt"), "other\n");
    git(dir, "git add other.txt");
    git(dir, 'git commit -m "feat: unrelated\n\nFusion-Task-Id: FN-OTHER"');
    const preAttemptHeadSha = git(dir, "git rev-parse HEAD");

    const result = await runFinalize(dir, "FN-TEST", "task", preAttemptHeadSha);
    expect(result.ok).toBe(false);
  }, 15000);
});

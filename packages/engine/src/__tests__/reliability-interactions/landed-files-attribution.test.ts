import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { captureRebaseLandedFilesForTask, sumShortstatsForCommits } from "../../merger.js";
import { filterFilesToOwnTaskCommits, SilentNoOpAttributionMismatchError } from "../../branch-attribution.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function commitFile(cwd: string, file: string, content: string, message: string, taskId?: string): Promise<string> {
  await writeFile(join(cwd, file), content, "utf-8");
  git(cwd, `git add ${JSON.stringify(file)}`);
  if (taskId) {
    git(cwd, `git commit -m ${JSON.stringify(message)} -m ${JSON.stringify(`Fusion-Task-Id: ${taskId}`)}`);
  } else {
    git(cwd, `git commit -m ${JSON.stringify(message)}`);
  }
  return git(cwd, "git rev-parse HEAD");
}

async function initRepo(prefix: string) {
  const repoDir = await mkdtemp(join(tmpdir(), prefix));
  git(repoDir, "git init -b main");
  git(repoDir, 'git config user.email "test@example.com"');
  git(repoDir, 'git config user.name "Test User"');
  await commitFile(repoDir, "README.md", "base\n", "chore: init", "FN-BASE");
  const baseSha = git(repoDir, "git rev-parse HEAD");
  return { repoDir, baseSha };
}

describeIfGit("FN-5103 reliability interaction: landed-files attribution", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("captures only own-commit files when rebased over foreign commits", async () => {
    const { repoDir, baseSha } = await initRepo("fn-5103-ri-");
    dirs.push(repoDir);
    const taskId = "FN-5103";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    const own1 = await commitFile(repoDir, "task-a.ts", "a\n", "feat(FN-5103): A", taskId);
    const own2 = await commitFile(repoDir, "task-b.ts", "b\n", "feat(FN-5103): B", taskId);
    const own3 = await commitFile(repoDir, "task-c.ts", "c\n", "feat(FN-5103): C", taskId);

    git(repoDir, "git checkout main");
    for (let i = 0; i < 5; i += 1) {
      await commitFile(repoDir, `other-${i}.ts`, `x${i}\n`, `feat(FN-OTHER-${i}): other`, `FN-OTHER-${i}`);
    }

    git(repoDir, `git checkout fusion/${taskId.toLowerCase()}`);
    git(repoDir, "git rebase main");

    const attribution = await filterFilesToOwnTaskCommits({ worktreePath: repoDir, baseRef: baseSha, taskId });
    expect(attribution.files).toEqual(["task-a.ts", "task-b.ts", "task-c.ts"]);
    expect(attribution.ownCommitCount).toBe(3);
    expect(attribution.foreignCommits.length).toBe(5);
    const stats = await sumShortstatsForCommits(repoDir, attribution.ownCommitShas ?? []);
    expect(stats.insertions).toBeGreaterThan(0);
    expect(stats.deletions).toBeGreaterThanOrEqual(0);
    const capture = await captureRebaseLandedFilesForTask({ rootDir: repoDir, rebaseMergeBaseSha: baseSha, recordedSha: git(repoDir, "git rev-parse HEAD"), taskId });
    expect(capture.landedFiles).toEqual(["task-a.ts", "task-b.ts", "task-c.ts"]);
    expect(capture.filesChanged).toBe(3);
    expect(capture.landedFilesAttributionRestricted).toBe(true);
    expect(capture.noOpVerifiedShortCircuit).toBeUndefined();
    expect([own1, own2, own3]).toHaveLength(3);
  });

  it("marks verified short-circuit shape when no own commits are attributable", async () => {
    const { repoDir, baseSha } = await initRepo("fn-5103-ri-");
    dirs.push(repoDir);
    const taskId = "FN-5103";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "foreign-only.ts", "x\n", "feat(FN-OTHER): foreign", "FN-OTHER");

    const capture = await captureRebaseLandedFilesForTask({ rootDir: repoDir, rebaseMergeBaseSha: baseSha, recordedSha: git(repoDir, "git rev-parse HEAD"), taskId });
    expect(capture.landedFiles).toEqual([]);
    expect(capture.noOpVerifiedShortCircuit).toBe(true);
    expect(capture.filesChanged).toBe(0);
    expect(capture.insertions).toBe(0);
    expect(capture.deletions).toBe(0);
  });

  it("FN-5304: refuses no-op fast-path when source branch tip still carries own commits", async () => {
    const { repoDir, baseSha } = await initRepo("fn-5304-ri-");
    dirs.push(repoDir);
    const taskId = "FN-5304";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "task-owned-a.ts", "a\n", "fix(FN-5304): owned A", taskId);
    await commitFile(repoDir, "task-owned-b.ts", "b\n", "fix(FN-5304): owned B", taskId);

    git(repoDir, "git checkout main");
    await commitFile(repoDir, "upstream-a.ts", "u\n", "fix(FN-9999): upstream A", "FN-9999");
    await commitFile(repoDir, "upstream-b.ts", "v\n", "fix(FN-9999): upstream B", "FN-9999");

    const recordedSha = git(repoDir, "git rev-parse HEAD");

    await expect(
      captureRebaseLandedFilesForTask({
        rootDir: repoDir,
        rebaseMergeBaseSha: baseSha,
        recordedSha,
        taskId,
        sourceBranchRef: `fusion/${taskId.toLowerCase()}`,
      }),
    ).rejects.toBeInstanceOf(SilentNoOpAttributionMismatchError);
  });

  it("surfaces attribution failure when git reads fail", async () => {
    const { repoDir, baseSha } = await initRepo("fn-5103-ri-");
    dirs.push(repoDir);
    const taskId = "FN-5103";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "task-owned.ts", "owned\n", "feat(FN-5103): own", taskId);

    const capture = await captureRebaseLandedFilesForTask({
      rootDir: repoDir,
      rebaseMergeBaseSha: baseSha,
      recordedSha: git(repoDir, "git rev-parse HEAD"),
      taskId,
      attributionExecAsyncImpl: async () => {
        throw new Error("forced attribution failure");
      },
    });

    expect(capture.landedFilesCaptureFallback).toBe("attribution-failed");
    expect(capture.landedFiles).toEqual(["task-owned.ts"]);
    expect(capture.filesChanged).toBe(1);
  });
});

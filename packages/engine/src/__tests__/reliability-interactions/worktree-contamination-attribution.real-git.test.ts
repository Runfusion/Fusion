import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import type { TaskStore } from "@fusion/core";
import { TaskExecutor } from "../../executor.js";

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

function makeExecutor(rootDir: string): TaskExecutor {
  const stubStore = { on: () => {} } as unknown as TaskStore;
  return new TaskExecutor(stubStore, rootDir);
}

describeIfGit("FN-5039 reliability interaction: worktree contamination attribution", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
  });

  if (!hasGit) {
    // eslint-disable-next-line no-console
    console.warn("Skipping FN-5039 real-git tests: git is not available");
  }

  async function initRepo() {
    const repoDir = await mkdtemp(join(tmpdir(), "fn-5039-ri-"));
    dirs.push(repoDir);
    git(repoDir, "git init -b main");
    git(repoDir, 'git config user.email "test@example.com"');
    git(repoDir, 'git config user.name "Test User"');
    await commitFile(repoDir, "README.md", "base\n", "chore: init", "FN-BASE");
    const baseSha = git(repoDir, "git rev-parse HEAD");
    return { repoDir, baseSha };
  }

  it("filters to own commit files after rebase contamination shape", async () => {
    const { repoDir, baseSha } = await initRepo();
    const taskId = "FN-TEST-5039";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "task-file.ts", "task\n", "feat: own change", taskId);

    git(repoDir, "git checkout main");
    await commitFile(repoDir, "unrelated-a.ts", "a\n", "feat: other 1", "FN-OTHER-1");
    await commitFile(repoDir, "unrelated-b.ts", "b\n", "feat: other 2", "FN-OTHER-2");
    await commitFile(repoDir, "unrelated-c.ts", "c\n", "feat: other 3", "FN-OTHER-3");

    git(repoDir, `git checkout fusion/${taskId.toLowerCase()}`);
    git(repoDir, "git rebase main");

    const executor = makeExecutor(repoDir);
    const audit = { database: vi.fn(async () => undefined) };
    const files = await (executor as any).captureModifiedFiles(repoDir, baseSha, taskId, audit, "scope-leak-guard");

    expect(files).toEqual(["task-file.ts"]);
    expect(audit.database).toHaveBeenCalledTimes(1);
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:worktree-contamination-detected",
      target: taskId,
      metadata: expect.objectContaining({
        rawDiffFileCount: 4,
        attributedFileCount: 1,
        foreignCommitCount: 3,
      }),
    }));
  });

  it("returns union for clean own-attributed branch without contamination audit", async () => {
    const { repoDir, baseSha } = await initRepo();
    const taskId = "FN-TEST-5039";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "task-a.ts", "a\n", "feat: own A", taskId);
    await commitFile(repoDir, "task-b.ts", "b\n", "feat: own B", taskId);

    const executor = makeExecutor(repoDir);
    const audit = { database: vi.fn(async () => undefined) };
    const files = await (executor as any).captureModifiedFiles(repoDir, baseSha, taskId, audit, "post-session");

    expect(files).toEqual(["task-a.ts", "task-b.ts"]);
    expect(audit.database).not.toHaveBeenCalled();
  });

  it("does not auto-attribute untrailered commits", async () => {
    const { repoDir, baseSha } = await initRepo();
    const taskId = "FN-TEST-5039";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "task-owned.ts", "owned\n", "feat: owned", taskId);
    await commitFile(repoDir, "task-untrailered.ts", "no trailer\n", "feat: untrailered");

    const executor = makeExecutor(repoDir);
    const audit = { database: vi.fn(async () => undefined) };
    const files = await (executor as any).captureModifiedFiles(repoDir, baseSha, taskId, audit, "post-session");

    expect(files).toEqual(["task-owned.ts"]);
    expect(audit.database).toHaveBeenCalledTimes(1);
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:worktree-contamination-detected",
      metadata: expect.objectContaining({
        rawDiffFileCount: 2,
        attributedFileCount: 1,
        foreignCommitCount: 1,
      }),
    }));
  });

  it("falls back without contamination audit when attribution fails", async () => {
    const { repoDir } = await initRepo();
    const taskId = "FN-TEST-5039";

    git(repoDir, `git checkout -b fusion/${taskId.toLowerCase()}`);
    await commitFile(repoDir, "task-owned.ts", "owned\n", "feat: owned", taskId);

    const executor = makeExecutor(repoDir);
    const audit = { database: vi.fn(async () => undefined) };
    const files = await (executor as any).captureModifiedFiles(
      repoDir,
      "definitely-not-a-ref",
      taskId,
      audit,
      "post-session",
    );

    expect(files).toEqual([]);
    expect(audit.database).not.toHaveBeenCalled();
  });
});

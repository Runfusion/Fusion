import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { DEFAULT_SETTINGS } from "@fusion/core";
import { aiMergeTask } from "../merger.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

type TaskWithPromptOverride = Partial<Task> & Pick<Task, "id"> & { prompt?: string };

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeTask(overrides: TaskWithPromptOverride): Task {
  const { id, ...rest } = overrides;
  return {
    ...rest,
    id,
    title: overrides.title ?? id,
    description: overrides.description ?? id,
    column: overrides.column ?? "in-review",
    dependencies: overrides.dependencies ?? [],
    steps: overrides.steps ?? [],
    currentStep: overrides.currentStep ?? 0,
    log: overrides.log ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  } as Task;
}

function createStore(task: Task, settings: Partial<Settings>): TaskStore {
  let currentTask = { ...task };
  const mergedSettings: Settings = {
    ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    mergeStrategy: "direct",
    directMergeCommitStrategy: "always-rebase",
    mergeConflictStrategy: "fail-fast",
    smartConflictResolution: true,
    autoMerge: true,
    includeTaskIdInCommit: false,
    commitAuthorEnabled: false,
    useAiMergeCommitSummary: false,
    ...settings,
  } as Settings;

  return {
    getTask: vi.fn(async () => currentTask),
    getSettings: vi.fn(async () => mergedSettings),
    listTasks: vi.fn(async () => [currentTask]),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => {
      currentTask = { ...currentTask, ...updates, updatedAt: new Date().toISOString() } as Task;
      return currentTask;
    }),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      currentTask = {
        ...currentTask,
        column,
        columnMovedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;
      return currentTask;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => mergedSettings),
    getActiveMergingTask: vi.fn(() => null),
    emit: vi.fn(),
    on: vi.fn(),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    getVerificationCacheHit: vi.fn(() => null),
    recordVerificationCachePass: vi.fn(() => undefined),
    upsertTaskCommitAssociation: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

describeIfGit("FN-4475 empty cherry-pick fallback handling", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  function setupRepo(prefix: string): string {
    const repo = mkdtempSync(join(tmpdir(), prefix));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    writeFileSync(join(repo, "README.md"), "init\n", "utf-8");
    git(repo, "git add README.md && git commit -m 'chore: init'");
    return repo;
  }

  it("FN-4475 treats -X ours fallback empty cherry-pick as already-on-main and completes done", async () => {
    const repo = setupRepo("fusion-merger-empty-fallback-ours-");
    writeFileSync(join(repo, "conflict.txt"), "base\n", "utf-8");
    git(repo, "git add conflict.txt && git commit -m 'chore: base conflict file'");
    const beforeConflictSha = git(repo, "git rev-parse HEAD");

    const branch = "fusion/fn-4475-fallback-ours";
    git(repo, `git checkout -b ${branch}`);
    writeFileSync(join(repo, "conflict.txt"), "branch-change\n", "utf-8");
    git(repo, "git add conflict.txt && git commit -m 'feat: branch conflict change'");

    git(repo, "git checkout main");
    writeFileSync(join(repo, "conflict.txt"), "main-change\n", "utf-8");
    git(repo, "git add conflict.txt && git commit -m 'feat: main conflict change'");
    const mainHeadBeforeMerge = git(repo, "git rev-parse HEAD");

    const task = makeTask({ id: "FN-4475-A", branch, baseBranch: "main", column: "in-review", prompt: "# Task\n" });
    const store = createStore(task, {
      mergeConflictStrategy: "smart-prefer-main",
      smartConflictResolution: true,
    });

    await aiMergeTask(store, repo, task.id);

    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(([, column]) => column === "done")).toBe(true);
    expect(git(repo, "git rev-parse HEAD")).toBe(mainHeadBeforeMerge);
    expect(existsSync(join(repo, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
    expect((store.logEntry as ReturnType<typeof vi.fn>).mock.calls.some(([id, msg]) => id === task.id
      && String(msg).includes("Auto-merge skipped: branch fully subsumed by main"))).toBe(true);
    expect((store.logEntry as ReturnType<typeof vi.fn>).mock.calls.some(([, msg]) => String(msg).includes("MergeConflictGiveUp"))).toBe(false);
    expect(beforeConflictSha).not.toBe(mainHeadBeforeMerge);
  }, 20_000);

  it("FN-4475 keeps smart-prefer-branch fallback non-empty picks as landed commits", async () => {
    const repo = setupRepo("fusion-merger-empty-fallback-theirs-nonempty-");
    writeFileSync(join(repo, "conflict.txt"), "base\n", "utf-8");
    git(repo, "git add conflict.txt && git commit -m 'chore: base conflict file'");

    const branch = "fusion/fn-4475-fallback-theirs";
    git(repo, `git checkout -b ${branch}`);
    writeFileSync(join(repo, "conflict.txt"), "branch-change\n", "utf-8");
    git(repo, "git add conflict.txt && git commit -m 'feat: branch conflict change'");

    git(repo, "git checkout main");
    writeFileSync(join(repo, "conflict.txt"), "main-change\n", "utf-8");
    git(repo, "git add conflict.txt && git commit -m 'feat: main conflict change'");

    const task = makeTask({ id: "FN-4475-B", branch, baseBranch: "main", column: "in-review", prompt: "# Task\n" });
    const store = createStore(task, {
      mergeConflictStrategy: "smart-prefer-branch",
      smartConflictResolution: true,
    });

    await aiMergeTask(store, repo, task.id);

    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(([, column]) => column === "done")).toBe(true);
    expect(git(repo, "git show HEAD:conflict.txt")).toBe("branch-change");
    expect((store.logEntry as ReturnType<typeof vi.fn>).mock.calls.some(([id, msg]) => id === task.id
      && String(msg).includes("Auto-merge skipped"))).toBe(false);
  }, 20_000);

});

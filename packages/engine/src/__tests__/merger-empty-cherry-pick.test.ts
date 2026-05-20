import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { DEFAULT_SETTINGS } from "@fusion/core";
import { aiMergeTask, isEmptyCherryPickError } from "../merger.js";

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

describe("isEmptyCherryPickError FN-4424", () => {
  it("matches git empty cherry-pick signatures only", () => {
    expect(isEmptyCherryPickError({ stderr: "The previous cherry-pick is now empty" })).toBe(true);
    expect(isEmptyCherryPickError({ stderr: "nothing to commit, working tree clean" })).toBe(true);
    expect(isEmptyCherryPickError({ stderr: "otherwise, please use 'git cherry-pick --skip'" })).toBe(true);
    expect(isEmptyCherryPickError({ stderr: "hint: use 'git commit --allow-empty'" })).toBe(true);
    expect(isEmptyCherryPickError({ stderr: "fatal: could not apply abc123" })).toBe(false);
    expect(isEmptyCherryPickError({ stderr: "empty" })).toBe(false);
  });
});

describeIfGit("FN-4424 empty cherry-pick handling (real git)", () => {
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

  it("FN-4424 all-empty subsumed branch completes done without new commit and cleans cherry-pick state", async () => {
    const repo = setupRepo("fusion-merger-empty-all-");
    writeFileSync(join(repo, "shared.txt"), "line-one\n", "utf-8");
    git(repo, "git add shared.txt && git commit -m 'fix: add shared line' ");
    const xSha = git(repo, "git rev-parse HEAD");

    const branch = "fusion/fn-4424-all-empty";
    git(repo, `git checkout -b ${branch} HEAD~1`);
    writeFileSync(join(repo, "shared.txt"), "line-one\n", "utf-8");
    git(repo, "git add shared.txt && git commit -m 'fix: duplicate shared line from parallel task'");
    git(repo, "git checkout main");

    const task = makeTask({ id: "FN-4424-A", branch, baseBranch: "main", column: "in-review", prompt: "# Task\n" });
    const store = createStore(task, {});

    await aiMergeTask(store, repo, task.id);

    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(([, column]) => column === "done")).toBe(true);
    expect(git(repo, "git rev-parse HEAD")).toBe(xSha);
    expect(existsSync(join(repo, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
    const sequencerDir = join(repo, ".git", "sequencer");
    if (existsSync(sequencerDir)) {
      expect(readdirSync(sequencerDir).length).toBe(0);
    }
    expect(git(repo, "git status --porcelain")).toBe("");
    expect((store.logEntry as ReturnType<typeof vi.fn>).mock.calls.some(([id, msg]) => id === task.id
      && String(msg).includes("Auto-merge skipped: branch fully subsumed by main"))).toBe(true);
  }, 20_000);

  it("FN-4424 partial-empty mixed branch skips duplicate and lands unique commit", async () => {
    const repo = setupRepo("fusion-merger-empty-partial-");
    writeFileSync(join(repo, "shared.txt"), "base\n", "utf-8");
    git(repo, "git add shared.txt && git commit -m 'fix: shared on main'");
    const xSha = git(repo, "git rev-parse HEAD");

    const branch = "fusion/fn-4424-partial";
    git(repo, `git checkout -b ${branch} HEAD~1`);
    writeFileSync(join(repo, "shared.txt"), "base\n", "utf-8");
    git(repo, "git add shared.txt && git commit -m 'fix: duplicate shared patch'");
    writeFileSync(join(repo, "unique.txt"), "unique\n", "utf-8");
    git(repo, "git add unique.txt && git commit -m 'feat: unique branch change'");
    git(repo, "git checkout main");

    const task = makeTask({ id: "FN-4424-B", branch, baseBranch: "main", column: "in-review", prompt: "# Task\n" });
    const store = createStore(task, {});

    await aiMergeTask(store, repo, task.id);

    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(([, column]) => column === "done")).toBe(true);
    const newShas = git(repo, `git rev-list --reverse ${xSha}..HEAD`).split("\n").filter(Boolean);
    expect(newShas).toHaveLength(1);
    expect(git(repo, "git cat-file -e HEAD:unique.txt && echo present")).toBe("present");
    expect((store.logEntry as ReturnType<typeof vi.fn>).mock.calls.some(([id, msg]) => id === task.id
      && String(msg).includes("Auto-merge skipped 1 empty cherry-pick(s); proceeded with 1 non-empty commit(s)"))).toBe(true);
  }, 20_000);

  it("FN-4424 real conflict still fails and does not complete task", async () => {
    const repo = setupRepo("fusion-merger-empty-conflict-");
    writeFileSync(join(repo, "conflict.txt"), "base\n", "utf-8");
    git(repo, "git add conflict.txt && git commit -m 'chore: base conflict file'");

    const branch = "fusion/fn-4424-conflict";
    git(repo, `git checkout -b ${branch}`);
    writeFileSync(join(repo, "conflict.txt"), "branch-change\n", "utf-8");
    git(repo, "git add conflict.txt && git commit -m 'feat: branch conflict change'");

    git(repo, "git checkout main");
    writeFileSync(join(repo, "conflict.txt"), "main-change\n", "utf-8");
    git(repo, "git add conflict.txt && git commit -m 'feat: main conflict change'");

    const task = makeTask({ id: "FN-4424-C", branch, baseBranch: "main", column: "in-review", prompt: "# Task\n" });
    const store = createStore(task, {});

    await expect(aiMergeTask(store, repo, task.id)).rejects.toThrow();
    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(([, column]) => column === "done")).toBe(false);
  }, 20_000);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";

type TaskWithPromptOverride = Partial<Task> & Pick<Task, "id"> & { prompt?: string };
import { DEFAULT_SETTINGS } from "@fusion/core";
import { aiMergeTask } from "../merger.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

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
    mergeStrategy: "direct",
    directMergeCommitStrategy: "auto",
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

describeIfGit("aiMergeTask direct merge commit routing (real git)", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  function setupRepo(): { repo: string; initSha: string } {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-commit-strategy-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    writeFileSync(join(repo, "README.md"), "init\n", "utf-8");
    git(repo, "git add README.md && git commit -m 'chore: init'");
    return { repo, initSha: git(repo, "git rev-parse HEAD") };
  }

  it("auto-routes multi-substantive branches to history-preserving direct merge", async () => {
    const { repo, initSha } = setupRepo();
    const branch = "fusion/fn-4069-test";

    git(repo, `git checkout -b ${branch}`);
    writeFileSync(join(repo, "src-fix.ts"), "export const fix = 1;\n", "utf-8");
    git(repo, "git add src-fix.ts && git commit -m 'fix: preserve original bugfix'");

    writeFileSync(join(repo, ".changeset-fn-4069.md"), "noop\n", "utf-8");
    git(repo, "mkdir -p .changeset && mv .changeset-fn-4069.md .changeset/fn-4069.md && git add .changeset/fn-4069.md && git commit -m 'chore: add changeset'");

    writeFileSync(join(repo, "src-style.css"), ".root { display: block; }\n", "utf-8");
    git(repo, "git add src-style.css && git commit -m 'feat: preserve follow-up polish'");
    git(repo, "git checkout main");

    const task = makeTask({
      id: "FN-4069",
      branch,
      baseBranch: "main",
      column: "in-review",
      prompt: "# Task\n",
    });
    const store = createStore(task, {});

    await aiMergeTask(store, repo, "FN-4069");

    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(([, column]) => column === "done")).toBe(true);

    const subjects = git(repo, `git log --reverse --format=%s ${initSha}..HEAD`).split("\n");
    expect(subjects).toEqual([
      "fix: preserve original bugfix",
      "chore: add changeset",
      "feat: preserve follow-up polish",
    ]);

    const landedShas = git(repo, `git rev-list --reverse ${initSha}..HEAD`).split("\n");
    expect(landedShas).toHaveLength(3);
    for (const sha of landedShas) {
      const body = git(repo, `git log -1 --format=%B ${sha}`);
      expect(body).toContain("Fusion-Task-Id: FN-4069");
    }
  }, 20_000);
});

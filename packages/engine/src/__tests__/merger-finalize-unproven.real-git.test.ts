import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { DEFAULT_SETTINGS } from "@fusion/core";

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(async () => ({ session: { prompt: vi.fn(async () => undefined), dispose: vi.fn() } })),
  describeModel: vi.fn(() => "mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: any, prompt: string, options?: any) => {
    if (options === undefined) {
      await session.prompt(prompt);
    } else {
      await session.prompt(prompt, options);
    }
  }),
  compactSessionContext: vi.fn(),
}));

import { aiMergeTask, classifyOwnedLandedEvidence } from "../merger.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function createStore(task: Task, settings: Partial<Settings> = {}): TaskStore {
  let currentTask = { ...task };
  const mergedSettings: Settings = {
    ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
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

describeIfGit("aiMergeTask finalize no-op unproven reproduction (real git)", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("classifies owned-commit when landed trailer commit exists on target", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-owned-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git commit --allow-empty -m 'init'");

    git(repo, "git checkout -b fusion/fn-owned");
    writeFileSync(join(repo, "owned.txt"), "owned\n", "utf-8");
    git(repo, "git add owned.txt && git commit -m 'feat(FN-OWNED): landed' -m 'Fusion-Task-Id: FN-OWNED'");
    const ownedSha = git(repo, "git rev-parse HEAD");
    git(repo, "git checkout main");
    git(repo, `git cherry-pick ${ownedSha}`);

    const classification = await classifyOwnedLandedEvidence(repo, { id: "FN-OWNED", branch: "fusion/fn-owned" } as Task, {
      mergeTargetBranch: "main",
    });
    expect(classification.kind).toBe("owned-commit");
  });

  it("classifies proven-no-op when branch is zero-ahead from merge target and base is reachable", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-proven-noop-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git commit --allow-empty -m 'init'");
    const baseSha = git(repo, "git rev-parse HEAD");

    git(repo, "git checkout -b fusion/fn-noop");
    git(repo, "git checkout main");

    const classification = await classifyOwnedLandedEvidence(
      repo,
      { id: "FN-NOOP", branch: "fusion/fn-noop", baseCommitSha: baseSha } as Task,
      { mergeTargetBranch: "main" },
    );
    expect(classification).toEqual({ kind: "proven-no-op", baseRef: "main", ownDiffEmpty: true });
  });

  // FN-5345/FN-5377 direct classifier coverage: empty-own-diff (aheadCount > 0
  // but zero net diff vs merge-base) is logically equivalent to proven-no-op.
  // This pairs with the merger's early fast-path and exercises the new branch
  // in classifyOwnedLandedEvidence that self-healing and post-handoff finalize
  // paths also rely on.
  it("classifies proven-no-op for empty-own-diff branches (FN-5345/FN-5377)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-empty-own-diff-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git commit --allow-empty -m 'init'");
    const baseSha = git(repo, "git rev-parse HEAD");

    git(repo, "git checkout -b fusion/fn-empty-own-diff");
    // 1 own commit with zero net tree change vs merge-base.
    git(repo, "git commit --allow-empty -m 'test(FN-EMPTY-OWN-DIFF): handoff'");
    const branchTipSha = git(repo, "git rev-parse HEAD");
    expect(branchTipSha).not.toBe(baseSha); // aheadCount >= 1
    git(repo, "git checkout main");

    const classification = await classifyOwnedLandedEvidence(
      repo,
      { id: "FN-EMPTY-OWN-DIFF", branch: "fusion/fn-empty-own-diff", baseCommitSha: baseSha } as Task,
      { mergeTargetBranch: "main" },
    );
    expect(classification).toEqual({ kind: "proven-no-op", baseRef: "main", ownDiffEmpty: true });
  });

  // FN-5490/FN-5517/FN-5526/FN-5540 regression: the previous contract here
  // was "auto-finalize proven no-op and clear stale modifiedFiles", which
  // turned out to be the bug — claimed modifiedFiles + no commit = lost work
  // (uncommitted in the worktree or squashed against the wrong branch), not
  // a legitimate no-op. The merger now refuses to finalize and moves the
  // task back to todo with progress preserved instead.
  it("FN-5490: refuses no-op finalize when modifiedFiles are claimed without a commit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-noop-finalize-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git commit --allow-empty -m 'init'");
    const baseSha = git(repo, "git rev-parse HEAD");
    git(repo, "git checkout -b fusion/fn-c");
    git(repo, "git checkout main");

    const task = {
      id: "FN-C",
      title: "FN-C",
      description: "FN-C",
      column: "in-review",
      branch: "fusion/fn-c",
      baseBranch: "main",
      baseCommitSha: baseSha,
      modifiedFiles: ["borrowed.txt"],
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt: "# FN-C",
    } as unknown as Task;

    const store = createStore(task);
    const result = await aiMergeTask(store, repo, "FN-C");

    // Lost-work guard fires — task does NOT advance to done, does NOT have
    // modifiedFiles cleared, and gets moved back to todo with progress.
    expect(result.merged).toBe(false);
    expect(result.error).toMatch(/lost-work/);
    expect(
      (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.some(
        ([, patch]) => Array.isArray(patch?.modifiedFiles) && patch.modifiedFiles.length === 0,
      ),
    ).toBe(false);
    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(([, column]) => column === "done")).toBe(false);
    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(([, column]) => column === "todo")).toBe(true);
  }, 20_000);

  it("blocks FN-4653 shape: foreign start-point branch with no FN-owned commits", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-unproven-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    writeFileSync(join(repo, "README.md"), "init\n", "utf-8");
    git(repo, "git add README.md && git commit -m 'chore: init'");
    git(repo, "git checkout -b fusion/fn-a");
    writeFileSync(join(repo, "foreign.txt"), "from fn-a\n", "utf-8");
    git(repo, "git add foreign.txt");
    git(repo, "git commit -m 'feat(FN-A): foreign start point' -m 'Fusion-Task-Id: FN-A'");
    const foreignBaseSha = git(repo, "git rev-parse HEAD");

    git(repo, "git checkout main");
    git(repo, "git checkout -b fusion/fn-b");
    git(repo, "git checkout main");

    const task = {
      id: "FN-B",
      title: "FN-B",
      description: "FN-B",
      column: "in-review",
      branch: "fusion/fn-b",
      baseBranch: "main",
      baseCommitSha: foreignBaseSha,
      modifiedFiles: ["foreign.txt"],
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt: "# FN-B",
    } as unknown as Task;

    const classification = await classifyOwnedLandedEvidence(repo, task, { mergeTargetBranch: "main" });
    expect(classification.kind).toBe("unproven");
    if (classification.kind === "unproven") {
      expect(classification.reason).toBe("foreign-start-point");
    }

    const store = createStore(task);
    const result = await aiMergeTask(store, repo, "FN-B");
    expect(result.merged).toBe(false);
    expect(result.error).toContain("finalize-unproven");
    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(([, column]) => column === "done")).toBe(false);
    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.some(([, column]) => column === "todo")).toBe(true);
  }, 20_000);
});

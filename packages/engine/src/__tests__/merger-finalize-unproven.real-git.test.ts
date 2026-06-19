import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchGroup, Settings, Task, TaskStore } from "@fusion/core";
import { DEFAULT_SETTINGS, isBranchGroupMemberLanded } from "@fusion/core";

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

function createStore(
  task: Task,
  settings: Partial<Settings> = {},
  branchGroup?: BranchGroup,
): TaskStore {
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
    getBranchGroup: vi.fn(() => branchGroup ?? null),
    recordBranchGroupMemberLanded: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
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

  it("FN-6461: demotes no-commits proven no-op tasks when skipped work outweighs done work", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-no-commits-noop-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git commit --allow-empty -m 'init'");
    const baseSha = git(repo, "git rev-parse HEAD");
    git(repo, "git checkout -b fusion/fn-no-commits");
    git(repo, "git checkout main");

    const task = {
      id: "FN-NO-COMMITS",
      title: "FN-NO-COMMITS",
      description: "FN-NO-COMMITS",
      column: "in-review",
      branch: "fusion/fn-no-commits",
      baseBranch: "main",
      baseCommitSha: baseSha,
      noCommitsExpected: true,
      dependencies: [],
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Dry-run", status: "skipped" },
        { name: "Execute", status: "skipped" },
        { name: "Verify", status: "skipped" },
        { name: "Testing", status: "skipped" },
        { name: "Documentation", status: "skipped" },
      ],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt: "# FN-NO-COMMITS",
    } as unknown as Task;

    const store = createStore(task);
    const result = await aiMergeTask(store, repo, "FN-NO-COMMITS");

    expect(result.merged).toBe(false);
    expect(result.noOp).toBe(false);
    expect(result.error).toContain("done=1, incomplete=5");
    expect(store.updateTask).toHaveBeenCalledWith("FN-NO-COMMITS", expect.objectContaining({ error: expect.stringContaining("done=1, incomplete=5") }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-NO-COMMITS", "todo", expect.objectContaining({ preserveProgress: true, moveSource: "engine" }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-NO-COMMITS", "done");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-NO-COMMITS",
      expect.stringContaining("Finalize blocked (no-commits incomplete-work guard)"),
      expect.stringContaining("legacy-no-op-classifier"),
    );
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:no-commits-finalize-blocked-incomplete-steps",
      target: "FN-NO-COMMITS",
    }));
  }, 20_000);

  it("FN-6461: allows all-done no-commits proven no-op tasks to finalize", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-no-commits-done-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git commit --allow-empty -m 'init'");
    const baseSha = git(repo, "git rev-parse HEAD");
    git(repo, "git checkout -b fusion/fn-no-commits-done");
    git(repo, "git checkout main");

    const task = {
      id: "FN-NO-COMMITS-DONE",
      title: "FN-NO-COMMITS-DONE",
      description: "FN-NO-COMMITS-DONE",
      column: "in-review",
      branch: "fusion/fn-no-commits-done",
      baseBranch: "main",
      baseCommitSha: baseSha,
      noCommitsExpected: true,
      dependencies: [],
      steps: [{ name: "Preflight", status: "done" }, { name: "Verify", status: "done" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt: "# FN-NO-COMMITS-DONE",
    } as unknown as Task;

    const store = createStore(task);
    const result = await aiMergeTask(store, repo, "FN-NO-COMMITS-DONE");

    expect(result.merged).toBe(true);
    expect(result.noOp).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-NO-COMMITS-DONE", "done");
  }, 20_000);

  it("FN-6461: demotes no-commits empty-own-diff fast-path before cleanup", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-no-commits-empty-own-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git commit --allow-empty -m 'init'");
    const baseSha = git(repo, "git rev-parse HEAD");
    git(repo, "git checkout -b fusion/fn-empty-block");
    git(repo, "git commit --allow-empty -m 'test(FN-EMPTY-BLOCK): no content change'");
    git(repo, "git checkout main");

    const task = {
      id: "FN-EMPTY-BLOCK",
      title: "FN-EMPTY-BLOCK",
      description: "FN-EMPTY-BLOCK",
      column: "in-review",
      branch: "fusion/fn-empty-block",
      baseBranch: "main",
      baseCommitSha: baseSha,
      noCommitsExpected: true,
      dependencies: [],
      steps: [{ name: "Preflight", status: "done" }, { name: "Execute", status: "skipped" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt: "# FN-EMPTY-BLOCK",
    } as unknown as Task;

    const store = createStore(task, { mergeIntegrationWorktree: "reuse-task-worktree" as any });
    const result = await aiMergeTask(store, repo, "FN-EMPTY-BLOCK");

    expect(result.merged).toBe(false);
    expect(result.error).toContain("done=1, incomplete=1");
    expect(store.moveTask).toHaveBeenCalledWith("FN-EMPTY-BLOCK", "todo", expect.objectContaining({ preserveProgress: true, moveSource: "engine" }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-EMPTY-BLOCK", "done");
    expect(git(repo, "git show-ref --verify --quiet refs/heads/fusion/fn-empty-block; echo $?")).toBe("0");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-EMPTY-BLOCK",
      expect.stringContaining("Finalize blocked (no-commits incomplete-work guard)"),
      expect.stringContaining("early-empty-own-diff"),
    );
  }, 20_000);

  it("FN-6461: allows all-done no-commits empty-own-diff fast-path tasks", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-no-commits-empty-done-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git commit --allow-empty -m 'init'");
    const baseSha = git(repo, "git rev-parse HEAD");
    git(repo, "git checkout -b fusion/fn-empty-done");
    git(repo, "git commit --allow-empty -m 'test(FN-EMPTY-DONE): no content change'");
    git(repo, "git checkout main");

    const task = {
      id: "FN-EMPTY-DONE",
      title: "FN-EMPTY-DONE",
      description: "FN-EMPTY-DONE",
      column: "in-review",
      branch: "fusion/fn-empty-done",
      baseBranch: "main",
      baseCommitSha: baseSha,
      noCommitsExpected: true,
      dependencies: [],
      steps: [{ name: "Preflight", status: "done" }, { name: "Verify", status: "done" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt: "# FN-EMPTY-DONE",
    } as unknown as Task;

    const store = createStore(task, { mergeIntegrationWorktree: "reuse-task-worktree" as any });
    const result = await aiMergeTask(store, repo, "FN-EMPTY-DONE");

    expect(result.merged).toBe(true);
    expect(result.noOp).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-EMPTY-DONE", "done");
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

  // FN-5345/FN-5377 + branch-group completion regression: a shared-group member
  // landing via the early empty-own-diff fast-path MUST stamp
  // mergeTargetSource === "branch-group-integration" on the persisted
  // mergeDetails (mirroring the standard landing paths), otherwise
  // isBranchGroupMemberLanded can never match and group promotion is
  // permanently blocked.
  it("stamps mergeTargetSource on early no-op fast-path so a shared-group member counts as landed", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-merger-group-noop-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git commit --allow-empty -m 'init'");
    const baseSha = git(repo, "git rev-parse HEAD");

    // Shared group integration branch (NOT a fusion/fn-* sibling) that the
    // member's own commits net to zero against → early fast-path territory.
    const groupBranch = "group/shared-integration";
    git(repo, `git checkout -b ${groupBranch}`);
    git(repo, "git checkout main");

    const memberBranch = "fusion/fn-grp-member";
    git(repo, `git checkout -b ${memberBranch} ${groupBranch}`);
    // 1 own commit with zero net tree change vs the group merge-base.
    git(repo, "git commit --allow-empty -m 'test(FN-GRP): handoff'");
    expect(git(repo, "git rev-parse HEAD")).not.toBe(baseSha); // aheadCount >= 1
    git(repo, "git checkout main");

    const group: BranchGroup = {
      id: "grp-1",
      sourceType: "planning" as BranchGroup["sourceType"],
      sourceId: "src-1",
      branchName: groupBranch,
      autoMerge: true,
      prState: "none" as BranchGroup["prState"],
      status: "open" as BranchGroup["status"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const task = {
      id: "FN-GRP",
      title: "FN-GRP",
      description: "FN-GRP",
      column: "in-review",
      branch: memberBranch,
      branchContext: { assignmentMode: "shared", groupId: group.id } as Task["branchContext"],
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt: "# FN-GRP",
    } as unknown as Task;

    const store = createStore(task, {}, group);
    const result = await aiMergeTask(store, repo, "FN-GRP");

    // Early no-op fast-path fired and finalized as a branch-group landing.
    expect(result.noOp).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.mergeTargetBranch).toBe(groupBranch);
    expect(result.mergeTargetSource).toBe("branch-group-integration");

    // Persisted mergeDetails carry the source so the completion predicate matches.
    const persisted = await store.getTask("FN-GRP");
    expect(persisted.mergeDetails?.mergeConfirmed).toBe(true);
    expect(persisted.mergeDetails?.mergeTargetBranch).toBe(groupBranch);
    expect(persisted.mergeDetails?.mergeTargetSource).toBe("branch-group-integration");
    expect(isBranchGroupMemberLanded(persisted, group)).toBe(true);
  }, 20_000);
});

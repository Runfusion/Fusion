import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

type TaskMap = Map<string, Task>;

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  const { id, ...rest } = overrides;
  return {
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
    ...rest,
  } as Task;
}

function createStore(tasks: TaskMap, settings: Partial<Settings> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const mergedSettings: Settings = {
    globalPause: false,
    enginePaused: false,
    maintenanceIntervalMs: 0,
    taskStuckTimeoutMs: 60_000,
    autoMerge: false,
    ...settings,
  } as Settings;

  const store = Object.assign(emitter, {
    getSettings: vi.fn(async () => mergedSettings),
    listTasks: vi.fn(async ({ column, includeArchived }: { column?: string; includeArchived?: boolean } = {}) => {
      const values = [...tasks.values()];
      return values.filter((task) => {
        if (!includeArchived && task.column === "archived") return false;
        if (column && task.column !== column) return false;
        return true;
      });
    }),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      const current = tasks.get(id)!;
      tasks.set(id, { ...current, ...updates, updatedAt: new Date().toISOString() } as Task);
      return tasks.get(id);
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const current = tasks.get(id)!;
      tasks.set(id, { ...current, column, columnMovedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as Task);
    }),
    logEntry: vi.fn(async (id: string, message: string) => {
      const current = tasks.get(id)!;
      const log = current.log ?? [];
      tasks.set(id, { ...current, log: [...log, { timestamp: new Date().toISOString(), action: message }] as any });
    }),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    archiveTaskAndCleanup: vi.fn(async () => ({})),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateSettings: vi.fn(async () => mergedSettings),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => ""),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;

  return store;
}

describeIfGit("SelfHealingManager recoverAlreadyMergedReviewTasks (real git)", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  function setupRepo(): string {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-3865-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test"');
    git(repo, "git commit --allow-empty -m 'init'");
    return repo;
  }

  it("recovers via trailer match and removes worktree", async () => {
    const repo = setupRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "file.txt"), "trailer\n", "utf-8");
    git(repo, "git add src/file.txt && git commit -m 'feat: landed' -m 'Fusion-Task-Id: FN-TEST-1'");
    const landedSha = git(repo, "git rev-parse HEAD");

    const worktreePath = path.join(repo, ".worktrees", "fn-test-1");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} -b fusion/fn-test-1`);

    const tasks: TaskMap = new Map([
      ["FN-TEST-1", makeTask({ id: "FN-TEST-1", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-test-1", worktree: worktreePath })],
    ]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await (manager as any).runMaintenance();

    const task = tasks.get("FN-TEST-1")!;
    expect(task.column).toBe("done");
    expect(task.status).toBeNull();
    expect(task.mergeRetries).toBe(0);
    expect(task.mergeDetails?.commitSha).toBe(landedSha);
    expect(task.mergeDetails?.mergeConfirmed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repo, "git worktree list")).not.toContain(worktreePath);
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledTimes(2);
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "database",
        mutationType: "task:auto-recover-already-merged",
        target: "FN-TEST-1",
      }),
    );
  });

  it(
    "recovers via patch-id fallback",
    async () => {
      const repo = setupRepo();
      git(repo, "git checkout -b fusion/fn-test-2");
      mkdirSync(path.join(repo, "src"), { recursive: true });
      writeFileSync(path.join(repo, "src", "patch.txt"), "patch-a\n", "utf-8");
      git(repo, "git add src/patch.txt && git commit -m 'task branch commit'");
      const branchTip = git(repo, "git rev-parse HEAD");
      git(repo, "git checkout main");
      mkdirSync(path.join(repo, "src"), { recursive: true });
      writeFileSync(path.join(repo, "src", "patch.txt"), "patch-a\n", "utf-8");
      git(repo, "git add src/patch.txt && git commit -m 'land equivalent change'");
      const landedSha = git(repo, "git rev-parse HEAD");

      const worktreePath = path.join(repo, ".worktrees", "fn-test-2");
      mkdirSync(path.dirname(worktreePath), { recursive: true });
      git(repo, `git worktree add ${JSON.stringify(worktreePath)} fusion/fn-test-2`);

      const tasks: TaskMap = new Map([
        ["FN-TEST-2", makeTask({ id: "FN-TEST-2", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-test-2", baseCommitSha: git(repo, "git merge-base main fusion/fn-test-2"), worktree: worktreePath })],
      ]);
      const store = createStore(tasks);
      const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

      expect(branchTip).toBeTruthy();
      await (manager as any).runMaintenance();

      const task = tasks.get("FN-TEST-2")!;
      expect(task.column).toBe("done");
      expect(task.mergeDetails?.commitSha).toBe(landedSha);
    },
    20_000,
  );

  it("recovers via tree-equal fallback when tips have identical trees but no trailer/ancestry/patch-id match", async () => {
    const repo = setupRepo();
    git(repo, "git checkout -b fusion/fn-test-tree");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "tree-equal.txt"), "line-1\nline-2\n", "utf-8");
    git(repo, "git add src/tree-equal.txt && git commit -m 'branch aggregate change'");
    git(repo, "git checkout main");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "tree-equal.txt"), "line-1\n", "utf-8");
    git(repo, "git add src/tree-equal.txt && git commit -m 'main part 1'");
    writeFileSync(path.join(repo, "src", "tree-equal.txt"), "line-1\nline-2\n", "utf-8");
    git(repo, "git add src/tree-equal.txt && git commit -m 'main part 2'");
    const landedSha = git(repo, "git rev-parse HEAD");

    const worktreePath = path.join(repo, ".worktrees", "fn-test-tree");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} fusion/fn-test-tree`);

    const tasks: TaskMap = new Map([
      ["FN-TEST-TREE", makeTask({ id: "FN-TEST-TREE", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-test-tree", worktree: worktreePath })],
    ]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await (manager as any).runMaintenance();

    const task = tasks.get("FN-TEST-TREE")!;
    expect(task.column).toBe("done");
    expect(task.status).toBeNull();
    expect(task.mergeRetries).toBe(0);
    expect(task.mergeDetails?.mergeConfirmed).toBe(true);
    expect(task.mergeDetails?.commitSha).toBe(landedSha);
    expect((store.logEntry as any).mock.calls.some((call: unknown[]) => String(call[1]).includes("tree-equal"))).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("does nothing when no match exists", async () => {
    const repo = setupRepo();
    git(repo, "git checkout -b fusion/fn-test-3");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "no-match.txt"), "branch-only\n", "utf-8");
    git(repo, "git add src/no-match.txt && git commit -m 'branch only'");
    git(repo, "git checkout main");

    const worktreePath = path.join(repo, ".worktrees", "fn-test-3");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} fusion/fn-test-3`);

    const tasks: TaskMap = new Map([
      ["FN-TEST-3", makeTask({ id: "FN-TEST-3", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-test-3", worktree: worktreePath })],
    ]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await (manager as any).runMaintenance();

    const task = tasks.get("FN-TEST-3")!;
    expect(task.column).toBe("in-review");
    expect(task.status).toBe("failed");
    expect(task.mergeRetries).toBe(3);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("is idempotent across two maintenance passes", async () => {
    const repo = setupRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "idempotent.txt"), "same\n", "utf-8");
    git(repo, "git add src/idempotent.txt && git commit -m 'feat: done' -m 'Fusion-Task-Id: FN-TEST-4'");

    const worktreePath = path.join(repo, ".worktrees", "fn-test-4");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} -b fusion/fn-test-4`);

    const tasks: TaskMap = new Map([
      ["FN-TEST-4", makeTask({ id: "FN-TEST-4", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-test-4", worktree: worktreePath })],
    ]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await (manager as any).runMaintenance();
    const firstRecoveryLogs = (store.logEntry as any).mock.calls.filter((call: unknown[]) => String(call[1]).includes("phantom-merge-guard false positive")).length;
    await (manager as any).runMaintenance();

    const secondRecoveryLogs = (store.logEntry as any).mock.calls.filter((call: unknown[]) => String(call[1]).includes("phantom-merge-guard false positive")).length;
    expect(firstRecoveryLogs).toBe(1);
    expect(secondRecoveryLogs).toBe(1);
  });

  it("short-circuits when paused", async () => {
    const repo = setupRepo();
    const tasks: TaskMap = new Map([
      ["FN-TEST-5", makeTask({ id: "FN-TEST-5", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-test-5" })],
    ]);

    const globalPausedStore = createStore(tasks, { globalPause: true, enginePaused: false });
    const globalPausedManager = new SelfHealingManager(globalPausedStore, { rootDir: repo, getExecutingTaskIds: () => new Set() });
    await globalPausedManager.recoverAlreadyMergedReviewTasks();
    expect(globalPausedStore.listTasks).not.toHaveBeenCalled();

    const enginePausedStore = createStore(tasks, { globalPause: false, enginePaused: true });
    const enginePausedManager = new SelfHealingManager(enginePausedStore, { rootDir: repo, getExecutingTaskIds: () => new Set() });
    await enginePausedManager.recoverAlreadyMergedReviewTasks();
    expect(enginePausedStore.listTasks).not.toHaveBeenCalled();
  });
});

// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
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
    autoMerge: true,
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

    await (manager as any).recoverAlreadyMergedReviewTasks();

    const task = tasks.get("FN-TEST-1")!;
    expect(task.column).toBe("done");
    expect(task.status).toBeNull();
    expect(task.mergeRetries).toBe(0);
    expect(task.mergeDetails?.commitSha).toBe(landedSha);
    expect(task.mergeDetails?.mergeConfirmed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repo, "git worktree list")).not.toContain(worktreePath);
    // Exercise only the already-merged recovery path here. Assert the recovery
    // audit events by type rather than exact total count so unrelated
    // environment-specific audit noise cannot re-flake this real-git test.
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "database",
        mutationType: "task:auto-recover-finalize-already-on-main",
        target: "FN-TEST-1",
      }),
    );
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "database",
        mutationType: "task:auto-recover-completion-fanout",
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
    expect((store.logEntry as any).mock.calls.some((call: unknown[]) => String(call[1]).includes("Auto-finalized from in-review/paused"))).toBe(true);
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

  it("recovers misbound in-review branch when main already carries task trailer", async () => {
    const repo = setupRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "other.txt"), "other\n", "utf-8");
    git(repo, "git add src/other.txt && git commit -m 'feat: unrelated generic tip'");
    const unrelatedSha = git(repo, "git rev-parse HEAD");

    writeFileSync(path.join(repo, "src", "misbound.txt"), "landed\n", "utf-8");
    git(repo, "git add src/misbound.txt && git commit -m 'feat: landed' -m 'Fusion-Task-Id: FN-TEST-MISBOUND'");
    const landedSha = git(repo, "git rev-parse HEAD");

    const worktreePath = path.join(repo, ".worktrees", "fn-test-misbound");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git branch fusion/fn-test-misbound ${unrelatedSha}`);
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} fusion/fn-test-misbound`);

    const tasks: TaskMap = new Map([
      ["FN-TEST-MISBOUND", makeTask({ id: "FN-TEST-MISBOUND", column: "in-review", status: "failed", paused: false, baseBranch: "main", branch: "fusion/fn-test-misbound", worktree: worktreePath })],
    ]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await (manager as any).runMaintenance();

    const task = tasks.get("FN-TEST-MISBOUND")!;
    expect(task.column).toBe("done");
    expect(task.branch).toBeNull();
    expect(task.worktree).toBeNull();
    expect(task.mergeDetails?.commitSha).toBe(landedSha);
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:auto-recover-branch-misbound", target: "FN-TEST-MISBOUND" }),
    );
  }, 20_000);

  it("recovers a no-op branch behind main from a previous task trailer tip without foreign-tip rejection", async () => {
    const repo = setupRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "previous-tip.txt"), "previous landed task\n", "utf-8");
    git(repo, "git add src/previous-tip.txt && git commit -m 'feat: previous landed' -m 'Fusion-Task-Id: FN-7477'");
    const previousLandedSha = git(repo, "git rev-parse HEAD");

    const worktreePath = path.join(repo, ".worktrees", "fn-7486-noop");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git branch fusion/fn-7486-noop ${previousLandedSha}`);
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} fusion/fn-7486-noop`);
    writeFileSync(path.join(repo, "src", "unrelated-after-noop.txt"), "unrelated after no-op branch\n", "utf-8");
    git(repo, "git add src/unrelated-after-noop.txt && git commit -m 'feat: unrelated after noop branch'");

    const tasks: TaskMap = new Map([
      ["FN-7486-NOOP", makeTask({ id: "FN-7486-NOOP", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-7486-noop", worktree: worktreePath })],
    ]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await (manager as any).recoverAlreadyMergedReviewTasks();

    const task = tasks.get("FN-7486-NOOP")!;
    expect(task.column).toBe("done");
    expect(task.status).toBeNull();
    expect(task.mergeDetails?.commitSha).toBe(previousLandedSha);
    expect(task.mergeDetails?.mergeConfirmed).toBe(true);
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-finalize-already-on-main",
      target: "FN-7486-NOOP",
      metadata: expect.objectContaining({ mergeStrategy: "no-diff" }),
    }));
    expect((store.logEntry as any).mock.calls.some((call: unknown[]) => String(call[1]).includes("already-merged rejected FN-7486-NOOP"))).toBe(false);
    expect((store as any).recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-already-merged-rejected",
      target: "FN-7486-NOOP",
      metadata: expect.objectContaining({ reason: "foreign-task-tip", candidateOwner: "FN-7477" }),
    }));
  }, 20_000);

  it("rejects already-merged recovery when the task branch tip has branch-only foreign work", async () => {
    const repo = setupRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    git(repo, "git checkout -b fusion/fn-7143");
    writeFileSync(path.join(repo, "src", "foreign-tip.txt"), "foreign\n", "utf-8");
    git(repo, "git add src/foreign-tip.txt && git commit -m 'feat: foreign branch work' -m 'Fusion-Task-Id: FN-7187'");

    git(repo, "git checkout main");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "owned-landed.txt"), "owned landed\n", "utf-8");
    git(repo, "git add src/owned-landed.txt && git commit -m 'feat: owned landed' -m 'Fusion-Task-Id: FN-7143'");

    const worktreePath = path.join(repo, ".worktrees", "fn-7143");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} fusion/fn-7143`);

    const tasks: TaskMap = new Map([
      ["FN-7143", makeTask({ id: "FN-7143", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-7143", worktree: worktreePath })],
    ]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await (manager as any).recoverAlreadyMergedReviewTasks();

    const task = tasks.get("FN-7143")!;
    expect(task.column).toBe("in-review");
    expect(task.mergeDetails?.mergeConfirmed).not.toBe(true);
    expect((store as any).moveTask).not.toHaveBeenCalledWith("FN-7143", "done");
    expect((store.logEntry as any).mock.calls.some((call: unknown[]) => String(call[1]).includes("already-merged rejected FN-7143") && String(call[1]).includes("owner=FN-7187"))).toBe(true);
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-already-merged-rejected",
      target: "FN-7143",
      metadata: expect.objectContaining({ reason: "foreign-task-tip", candidateOwner: "FN-7187" }),
    }));
  }, 20_000);

  it("rejects already-merged recovery when the task branch tip carries a foreign lineage", async () => {
    const repo = setupRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    git(repo, "git checkout -b fusion/fn-7143-lineage");
    writeFileSync(path.join(repo, "src", "foreign-lineage-tip.txt"), "foreign lineage\n", "utf-8");
    git(repo, "git add src/foreign-lineage-tip.txt && git commit -m 'feat: foreign lineage branch work' -m 'Fusion-Task-Lineage: LINEAGE-OTHER'");

    git(repo, "git checkout main");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "owned-lineage-landed.txt"), "owned lineage landed\n", "utf-8");
    git(repo, "git add src/owned-lineage-landed.txt && git commit -m 'feat: owned lineage landed' -m 'Fusion-Task-Id: FN-7143-LINEAGE' -m 'Fusion-Task-Lineage: LINEAGE-OWN'");

    const worktreePath = path.join(repo, ".worktrees", "fn-7143-lineage");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} fusion/fn-7143-lineage`);

    const tasks: TaskMap = new Map([
      ["FN-7143-LINEAGE", makeTask({ id: "FN-7143-LINEAGE", lineageId: "LINEAGE-OWN", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-7143-lineage", worktree: worktreePath })],
    ]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await (manager as any).recoverAlreadyMergedReviewTasks();

    const task = tasks.get("FN-7143-LINEAGE")!;
    expect(task.column).toBe("in-review");
    expect(task.mergeDetails?.mergeConfirmed).not.toBe(true);
    expect((store as any).moveTask).not.toHaveBeenCalledWith("FN-7143-LINEAGE", "done");
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-already-merged-rejected",
      target: "FN-7143-LINEAGE",
      metadata: expect.objectContaining({ reason: "foreign-lineage-tip", candidateOwner: "LINEAGE-OTHER" }),
    }));
  }, 20_000);

  it("rejects branch-misbound finalization when the misbound tip belongs to a foreign task", async () => {
    const repo = setupRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "other.txt"), "other\n", "utf-8");
    git(repo, "git add src/other.txt && git commit -m 'feat: unrelated' -m 'Fusion-Task-Id: FN-OTHER'");
    const foreignSha = git(repo, "git rev-parse HEAD");

    writeFileSync(path.join(repo, "src", "owned.txt"), "owned\n", "utf-8");
    git(repo, "git add src/owned.txt && git commit -m 'feat: landed' -m 'Fusion-Task-Id: FN-TEST-FOREIGN-MISBOUND'");

    const worktreePath = path.join(repo, ".worktrees", "fn-test-foreign-misbound");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git branch fusion/fn-test-foreign-misbound ${foreignSha}`);
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} fusion/fn-test-foreign-misbound`);

    const tasks: TaskMap = new Map([
      ["FN-TEST-FOREIGN-MISBOUND", makeTask({ id: "FN-TEST-FOREIGN-MISBOUND", column: "in-review", status: "failed", paused: false, baseBranch: "main", branch: "fusion/fn-test-foreign-misbound", worktree: worktreePath })],
    ]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await (manager as any).runMaintenance();

    const task = tasks.get("FN-TEST-FOREIGN-MISBOUND")!;
    expect(task.column).toBe("in-review");
    expect(task.mergeDetails?.mergeConfirmed).not.toBe(true);
    expect((store as any).moveTask).not.toHaveBeenCalledWith("FN-TEST-FOREIGN-MISBOUND", "done");
    expect((store.logEntry as any).mock.calls.some((call: unknown[]) => String(call[1]).includes("already-merged rejected FN-TEST-FOREIGN-MISBOUND") && String(call[1]).includes("owner=FN-OTHER"))).toBe(true);
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-already-merged-rejected",
      target: "FN-TEST-FOREIGN-MISBOUND",
      metadata: expect.objectContaining({ reason: "foreign-task-tip", candidateOwner: "FN-OTHER" }),
    }));
  }, 20_000);

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

    await (manager as any).recoverAlreadyMergedReviewTasks();
    const firstRecoveryLogs = (store.logEntry as any).mock.calls.filter((call: unknown[]) => String(call[1]).includes("Auto-finalized from in-review/paused")).length;
    await (manager as any).recoverAlreadyMergedReviewTasks();

    const secondRecoveryLogs = (store.logEntry as any).mock.calls.filter((call: unknown[]) => String(call[1]).includes("Auto-finalized from in-review/paused")).length;
    expect(firstRecoveryLogs).toBe(1);
    expect(secondRecoveryLogs).toBe(1);
  }, 20_000);

  it("short-circuits when paused", async () => {
    const repo = setupRepo();
    const tasks: TaskMap = new Map([
      ["FN-TEST-5", makeTask({ id: "FN-TEST-5", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-test-5" })],
    ]);

    const globalPausedStore = createStore(tasks, { autoMerge: true, globalPause: true, enginePaused: false });
    const globalPausedManager = new SelfHealingManager(globalPausedStore, { rootDir: repo, getExecutingTaskIds: () => new Set() });
    await globalPausedManager.recoverAlreadyMergedReviewTasks();
    expect(globalPausedStore.listTasks).not.toHaveBeenCalled();

    const enginePausedStore = createStore(tasks, { autoMerge: true, globalPause: false, enginePaused: true });
    const enginePausedManager = new SelfHealingManager(enginePausedStore, { rootDir: repo, getExecutingTaskIds: () => new Set() });
    await enginePausedManager.recoverAlreadyMergedReviewTasks();
    expect(enginePausedStore.listTasks).not.toHaveBeenCalled();
  }, 20_000);

  // PR3: the local base ref can be stale. When a PR squash-merged on the remote
  // but this process never fetched, the owned commit is absent from the LOCAL
  // base branch, so the detector finds nothing and the failed card holds its
  // file-scope lease forever. Recovery now fetches origin/<base> (gated on a
  // recorded PR) and re-runs the SAME evidence detector against origin/<base>.
  function setupRepoWithRemote(): { repo: string; remote: string } {
    const remoteParent = mkdtempSync(path.join(os.tmpdir(), "fn-stale-remote-"));
    repos.push(remoteParent);
    const remote = path.join(remoteParent, "origin.git");
    execSync(`git init --bare -b main ${JSON.stringify(remote)}`, { stdio: ["pipe", "pipe", "pipe"] });
    const repo = setupRepo();
    git(repo, `git remote add origin ${JSON.stringify(remote)}`);
    git(repo, "git push origin main");
    return { repo, remote };
  }

  // Clone the bare remote, run `mutate` in it, push main back. Advances the
  // remote's main WITHOUT touching the primary repo's local main / origin/main
  // tracking ref — i.e. it manufactures a genuinely stale local base.
  function landOnRemoteMain(remote: string, mutate: (clone: string) => void): string {
    const cloneParent = mkdtempSync(path.join(os.tmpdir(), "fn-stale-clone-"));
    repos.push(cloneParent);
    const clone = path.join(cloneParent, "clone");
    execSync(`git clone ${JSON.stringify(remote)} ${JSON.stringify(clone)}`, { stdio: ["pipe", "pipe", "pipe"] });
    git(clone, 'git config user.email "test@example.com"');
    git(clone, 'git config user.name "Test"');
    mutate(clone);
    git(clone, "git push origin main");
    return git(clone, "git rev-parse HEAD");
  }

  it("fetch-then-prove: finalizes a failed card whose PR merged on the remote (stale local base)", async () => {
    const { repo, remote } = setupRepoWithRemote();

    // Task branch tip lives locally (owned by nothing foreign).
    git(repo, "git checkout -b fusion/fn-stale");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "stale.txt"), "work\n", "utf-8");
    git(repo, "git add src/stale.txt && git commit -m 'task work'");
    git(repo, "git checkout main");

    const worktreePath = path.join(repo, ".worktrees", "fn-stale");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, `git worktree add ${JSON.stringify(worktreePath)} fusion/fn-stale`);

    // Simulate the merge-train squash landing on the remote — never fetched locally.
    const landedSha = landOnRemoteMain(remote, (clone) => {
      git(clone, "git commit --allow-empty -m 'feat: landed' -m 'Fusion-Task-Id: FN-STALE'");
    });

    // Local base is stale: neither main nor origin/main has the owned commit yet.
    expect(git(repo, "git rev-parse origin/main")).not.toBe(landedSha);

    const tasks: TaskMap = new Map([
      ["FN-STALE", makeTask({ id: "FN-STALE", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-stale", worktree: worktreePath, prInfo: { number: 77 } as any })],
    ]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await (manager as any).recoverAlreadyMergedReviewTasks();

    // Fetch advanced origin/main, and the detector proved the owned commit against it.
    expect(git(repo, "git rev-parse origin/main")).toBe(landedSha);
    const task = tasks.get("FN-STALE")!;
    expect(task.column).toBe("done");
    expect(task.status).toBeNull();
    expect(task.mergeRetries).toBe(0);
    expect(task.mergeDetails?.commitSha).toBe(landedSha);
    expect(task.mergeDetails?.mergeConfirmed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  }, 30_000);

  it("fetch-then-prove: does NOT heal when the remote base carries only a foreign commit", async () => {
    const { repo, remote } = setupRepoWithRemote();

    git(repo, "git checkout -b fusion/fn-guard");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "guard.txt"), "work\n", "utf-8");
    git(repo, "git add src/guard.txt && git commit -m 'task work'");
    git(repo, "git checkout main");

    // Remote base advances, but the landed commit is owned by a DIFFERENT task.
    const foreignSha = landOnRemoteMain(remote, (clone) => {
      git(clone, "git commit --allow-empty -m 'feat: other' -m 'Fusion-Task-Id: FN-OTHER'");
    });

    const tasks: TaskMap = new Map([
      ["FN-GUARD", makeTask({ id: "FN-GUARD", column: "in-review", status: "failed", mergeRetries: 3, paused: false, baseBranch: "main", branch: "fusion/fn-guard", prInfo: { number: 88 } as any })],
    ]);
    const store = createStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: repo, getExecutingTaskIds: () => new Set() });

    await (manager as any).recoverAlreadyMergedReviewTasks();

    // The fetch still ran (proves the guard, not a missing fetch), but no owned
    // commit exists → the card is left untouched, never phantom-finalized.
    expect(git(repo, "git rev-parse origin/main")).toBe(foreignSha);
    const task = tasks.get("FN-GUARD")!;
    expect(task.column).toBe("in-review");
    expect(task.status).toBe("failed");
    expect(task.mergeDetails?.mergeConfirmed).not.toBe(true);
  }, 30_000);
});

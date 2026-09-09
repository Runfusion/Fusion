/*
FNXC:TaskDeletionWorktrees 2026-09-07-12:00:
These real-Git regressions reproduce the operator-visible leak through persisted singular and workspace
paths. They assert deletion removes both the directory and Git registration, while duplicate delivery,
foreign claims, repository roots, and live sessions remain fail-closed.
*/
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { createTaskStoreForTest } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  ActiveSessionPathHeldError,
  activeSessionRegistry,
  executingTaskLock,
} from "../agents/active-session-registry.js";
import { SelfHealingManager } from "../self-healing.js";
import { cleanupDeletedTaskWorktrees } from "../worktree/deleted-task-worktree-cleanup.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function task(id: string, patch: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id,
    title: id,
    description: "",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    paused: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: now,
    ...patch,
  } as Task;
}

function createRepository(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "fusion-fn-309-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "root\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "initial");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("deleted task worktree cleanup", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => activeSessionRegistry.clear());
  afterEach(() => {
    activeSessionRegistry.clear();
    executingTaskLock.release("FN-309");
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("removes a dirty singular task worktree and becomes an idempotent prune", async () => {
    const repo = createRepository();
    cleanups.push(repo.cleanup);
    const worktreePath = join(repo.root, ".fusion", "worktrees", "fn-309");
    mkdirSync(join(repo.root, ".fusion", "worktrees"), { recursive: true });
    git(repo.root, "worktree", "add", "-b", "fusion/fn-309", worktreePath, "HEAD");
    writeFileSync(join(worktreePath, "dirty.txt"), "discarded by explicit deletion\n");
    const deleted = task("FN-309", { worktree: worktreePath, branch: "fusion/fn-309" });

    const first = await cleanupDeletedTaskWorktrees({ task: deleted, allTasks: [deleted], rootDir: repo.root, settings: {} });
    expect(first.targets).toEqual([expect.objectContaining({ status: "removed" })]);
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repo.root, "worktree", "list", "--porcelain")).not.toContain(worktreePath);

    const second = await cleanupDeletedTaskWorktrees({ task: deleted, allTasks: [deleted], rootDir: repo.root, settings: {} });
    expect(second.targets).toEqual([expect.objectContaining({ status: "already-absent" })]);
    expect(second.converged).toBe(true);
  });

  it("converges from TaskStore.deleteTask and duplicate observed deliveries without a direct reconcile call", async () => {
    const harness = await createTaskStoreForTest({
      prefix: "fusion_fn_309_delete",
      copyFromGolden: true,
      projectId: "fn-309-delete-worktree",
    });
    const store = harness.store;
    const rootDir = harness.rootDir;
    git(rootDir, "init", "-b", "main");
    git(rootDir, "config", "user.email", "test@example.com");
    git(rootDir, "config", "user.name", "Test");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add", "README.md");
    git(rootDir, "commit", "-m", "initial");
    const created = await store.createTask({ description: "delete the owned worktree" });
    const worktreePath = join(rootDir, ".fusion", "worktrees", created.id.toLowerCase());
    mkdirSync(join(rootDir, ".fusion", "worktrees"), { recursive: true });
    git(rootDir, "worktree", "add", "-b", `fusion/${created.id.toLowerCase()}`, worktreePath, "HEAD");
    await store.updateTask(created.id, {
      worktree: worktreePath,
      branch: `fusion/${created.id.toLowerCase()}`,
      branchWriteOrigin: "engine",
    });

    let targetedCleanupCount = 0;
    const targetedCleanupWaiters = new Map<number, () => void>();
    const waitForTargetedCleanup = (): Promise<void> => {
      const expectedCount = targetedCleanupCount + 1;
      return new Promise<void>((resolve) => targetedCleanupWaiters.set(expectedCount, resolve));
    };
    class ObservableSelfHealingManager extends SelfHealingManager {
      override async reconcileDeletedTaskWorktrees(options: { includeTaskIds?: ReadonlySet<string> } = {}): Promise<number> {
        const result = await super.reconcileDeletedTaskWorktrees(options);
        if (options.includeTaskIds?.has(created.id)) {
          targetedCleanupCount++;
          targetedCleanupWaiters.get(targetedCleanupCount)?.();
          targetedCleanupWaiters.delete(targetedCleanupCount);
        }
        return result;
      }
    }
    const manager = new ObservableSelfHealingManager(store, { rootDir } as never);
    manager.start();
    try {
      const localCleanup = waitForTargetedCleanup();
      const deleted = await store.deleteTask(created.id);
      await localCleanup;
      expect(existsSync(worktreePath)).toBe(false);
      expect(git(rootDir, "worktree", "list", "--porcelain")).not.toContain(worktreePath);
      expect(deleted.deletedAt).toBeTruthy();
      expect((await store.getTask(created.id, { includeDeleted: true }))?.deletedAt).toBeTruthy();

      const observedCleanup = waitForTargetedCleanup();
      store.emitObservedTaskDeleted(deleted, "evt-1");
      store.emitObservedTaskDeleted(deleted, "evt-1");
      await observedCleanup;
      expect(targetedCleanupCount).toBe(2);
      expect(existsSync(worktreePath)).toBe(false);
      expect((await store.getTask(created.id, { includeDeleted: true }))?.deletedAt).toBeTruthy();
    } finally {
      manager.stop();
      await harness.teardown();
    }
  });

  it("removes every modern workspace child once and then removes the empty coordinator", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "fusion-fn-309-workspace-"));
    cleanups.push(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    const repos = ["repo-a", "repo-b"];
    const workspaceWorktrees: NonNullable<Task["workspaceWorktrees"]> = {};
    for (const repoRelPath of repos) {
      const repoRoot = join(workspaceRoot, repoRelPath);
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, "init", "-b", "main");
      git(repoRoot, "config", "user.email", "test@example.com");
      git(repoRoot, "config", "user.name", "Test");
      writeFileSync(join(repoRoot, "README.md"), `${repoRelPath}\n`);
      git(repoRoot, "add", "README.md");
      git(repoRoot, "commit", "-m", "initial");
      const worktreePath = join(workspaceRoot, ".fusion", "worktrees", "fn-309", repoRelPath);
      mkdirSync(join(workspaceRoot, ".fusion", "worktrees", "fn-309"), { recursive: true });
      git(repoRoot, "worktree", "add", "-b", `fusion/fn-309-${repoRelPath}`, worktreePath, "HEAD");
      workspaceWorktrees[repoRelPath] = { worktreePath, branch: `fusion/fn-309-${repoRelPath}` };
    }
    const deleted = task("FN-309", { workspaceWorktrees });

    const result = await cleanupDeletedTaskWorktrees({ task: deleted, allTasks: [deleted], rootDir: workspaceRoot, settings: {} });
    expect(result.targets.map((target) => target.status)).toEqual(["removed", "removed"]);
    expect(result.taskDirectoryRemoved).toBe(true);
    expect(existsSync(join(workspaceRoot, ".fusion", "worktrees", "fn-309"))).toBe(false);

    const replay = await cleanupDeletedTaskWorktrees({ task: deleted, allTasks: [deleted], rootDir: workspaceRoot, settings: {} });
    expect(replay.targets.map((target) => target.status)).toEqual(["already-absent", "already-absent"]);
    expect(replay.converged).toBe(true);
  });

  it("uses the qualified workspace repository when the singular pointer aliases a workspace child", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "fusion-fn-309-alias-"));
    cleanups.push(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    const repoRoot = join(workspaceRoot, "repo-a");
    mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, "init", "-b", "main");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "README.md"), "repo-a\n");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");
    const worktreePath = join(workspaceRoot, ".fusion", "worktrees", "fn-309", "repo-a");
    mkdirSync(join(workspaceRoot, ".fusion", "worktrees", "fn-309"), { recursive: true });
    git(repoRoot, "worktree", "add", "-b", "fusion/fn-309-repo-a", worktreePath, "HEAD");
    const deleted = task("FN-309", {
      worktree: worktreePath,
      workspaceWorktrees: { "repo-a": { worktreePath, branch: "fusion/fn-309-repo-a" } },
    });

    const result = await cleanupDeletedTaskWorktrees({
      task: deleted,
      allTasks: [deleted],
      rootDir: workspaceRoot,
      settings: {},
    });

    expect(result.targets).toEqual([expect.objectContaining({ repoRelPath: "repo-a", status: "removed" })]);
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repoRoot, "worktree", "list", "--porcelain")).not.toContain(worktreePath);
  });

  it("defers when a same-task executor wins immediately before the exclusive cleanup reservation", async () => {
    const repo = createRepository();
    cleanups.push(repo.cleanup);
    const worktreePath = join(repo.root, ".fusion", "worktrees", "fn-309");
    mkdirSync(join(repo.root, ".fusion", "worktrees"), { recursive: true });
    git(repo.root, "worktree", "add", "-b", "fusion/fn-309", worktreePath, "HEAD");
    const deleted = task("FN-309", { worktree: worktreePath });
    const remove = vi.fn();
    let livenessChecks = 0;

    const result = await cleanupDeletedTaskWorktrees({
      task: deleted,
      allTasks: [deleted],
      rootDir: repo.root,
      settings: {},
      remove,
      isMergePending: () => {
        livenessChecks++;
        if (livenessChecks === 2) {
          activeSessionRegistry.registerPath(worktreePath, {
            taskId: deleted.id,
            kind: "executor",
            ownerKey: "executor-race-winner",
          });
        }
        return false;
      },
    });

    expect(result.targets).toEqual([expect.objectContaining({ status: "deferred-live" })]);
    expect(remove).not.toHaveBeenCalled();
    expect(activeSessionRegistry.lookupByPath(worktreePath)?.ownerKey).toBe("executor-race-winner");
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("prevents a same-task executor from replacing cleanup after the exclusive reservation wins", async () => {
    const repo = createRepository();
    cleanups.push(repo.cleanup);
    const worktreePath = join(repo.root, ".fusion", "worktrees", "fn-309");
    mkdirSync(join(repo.root, ".fusion", "worktrees"), { recursive: true });
    git(repo.root, "worktree", "add", "-b", "fusion/fn-309", worktreePath, "HEAD");
    const deleted = task("FN-309", { worktree: worktreePath });
    let contenderError: unknown;

    const result = await cleanupDeletedTaskWorktrees({
      task: deleted,
      allTasks: [deleted],
      rootDir: repo.root,
      settings: {},
      remove: async () => {
        expect(activeSessionRegistry.lookupByPath(worktreePath)?.kind).toBe("task-deletion-cleanup");
        try {
          activeSessionRegistry.registerPath(worktreePath, {
            taskId: deleted.id,
            kind: "executor",
            ownerKey: "executor-late-contender",
          });
        } catch (error) {
          contenderError = error;
        } finally {
          activeSessionRegistry.unregisterPath(worktreePath);
        }
        expect(activeSessionRegistry.reconcileStaleSelfOwned(worktreePath, deleted.id)).toEqual({
          reconciled: false,
          reason: "exclusive-reservation",
        });
        expect(activeSessionRegistry.lookupByPath(worktreePath)?.kind).toBe("task-deletion-cleanup");
        return { removed: true, classification: "removed" };
      },
    });

    expect(contenderError).toBeInstanceOf(ActiveSessionPathHeldError);
    expect(result.targets).toEqual([expect.objectContaining({ status: "removed" })]);
    expect(activeSessionRegistry.lookupByPath(worktreePath)).toBeNull();
  });

  it("deduplicates path aliases but refuses roots, foreign claims, and active sessions", async () => {
    const repo = createRepository();
    cleanups.push(repo.cleanup);
    const worktreePath = join(repo.root, ".fusion", "worktrees", "fn-309");
    mkdirSync(join(repo.root, ".fusion", "worktrees"), { recursive: true });
    git(repo.root, "worktree", "add", "-b", "fusion/fn-309", worktreePath, "HEAD");
    const deleted = task("FN-309", {
      worktree: worktreePath,
      workspaceWorktrees: { duplicate: { worktreePath, branch: "fusion/fn-309" } },
    });
    const foreign = task("FN-OTHER", { deletedAt: undefined, worktree: worktreePath });

    const claimed = await cleanupDeletedTaskWorktrees({ task: deleted, allTasks: [deleted, foreign], rootDir: repo.root, settings: {} });
    expect(claimed.targets).toHaveLength(1);
    expect(claimed.targets[0]?.status).toBe("refused-ownership");
    expect(existsSync(worktreePath)).toBe(true);

    activeSessionRegistry.registerPath(worktreePath, { taskId: "FN-309", kind: "executor", ownerKey: "live" });
    const live = await cleanupDeletedTaskWorktrees({ task: deleted, allTasks: [deleted], rootDir: repo.root, settings: {} });
    expect(live.targets).toEqual([expect.objectContaining({ status: "deferred-live" })]);
    expect(existsSync(worktreePath)).toBe(true);

    activeSessionRegistry.clear();
    const rootTask = task("FN-309", { worktree: repo.root });
    const rootResult = await cleanupDeletedTaskWorktrees({ task: rootTask, allTasks: [rootTask], rootDir: repo.root, settings: {} });
    expect(rootResult.targets).toEqual([expect.objectContaining({ status: "refused-ownership" })]);
    expect(existsSync(repo.root)).toBe(true);

    const unregisteredPath = join(repo.root, ".fusion", "worktrees", "unregistered");
    mkdirSync(unregisteredPath, { recursive: true });
    writeFileSync(join(unregisteredPath, "operator.txt"), "preserve\n");
    const unregisteredTask = task("FN-309", { worktree: unregisteredPath });
    const unregistered = await cleanupDeletedTaskWorktrees({ task: unregisteredTask, allTasks: [unregisteredTask], rootDir: repo.root, settings: {} });
    expect(unregistered.targets).toEqual([expect.objectContaining({ status: "refused-ownership", detail: "not-registered-by-expected-repository" })]);
    expect(existsSync(join(unregisteredPath, "operator.txt"))).toBe(true);
  });
});

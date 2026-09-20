import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BranchConflictError } from "../execution/branch-conflicts.js";
import { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import { BranchWorktreeAutoRecoveryHandler } from "../auto-recovery-handlers/branch-worktree.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { NativeWorktreeBackend } from "../worktree/worktree-backend.js";

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function assertRegisteredWorktree(repo: string, worktreePath: string, branch: string): void {
  const porcelain = git(repo, "git worktree list --porcelain");
  expect(porcelain).toContain(`worktree ${realpathSync(worktreePath)}`);
  expect(porcelain).toContain(`branch refs/heads/${branch}`);
}

describe("NativeWorktreeBackend bare branch collision recovery", { timeout: 60_000 }, () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): string {
    const repo = mkdtempSync(join(tmpdir(), "fn-8132-collision-"));
    dirs.push(repo);
    git(repo, "git init -q -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, "git add base.txt && git commit -qm base");
    return repo;
  }

  function commit(repo: string, file: string, message: string): void {
    writeFileSync(join(repo, file), `${message}\n`);
    git(repo, `git add ${JSON.stringify(file)} && git commit -m ${JSON.stringify(message)}`);
  }

  async function create(repo: string, branch: string, taskId: string, allowSiblingBranchRename = false) {
    const target = join(repo, ".worktrees", `target-${taskId.toLowerCase()}`);
    const events: any[] = [];
    const result = await new NativeWorktreeBackend({ audit: { git: async (event: any) => { events.push(event); } } as any }).create({
      rootDir: repo,
      branch,
      worktreePath: target,
      startPoint: "main",
      taskId,
      allowSiblingBranchRename,
    });
    return { result, target, events };
  }

  it("recreates a dangling canonical branch from main without creating a sibling", async () => {
    const repo = setup();
    git(repo, "git branch fusion/fn-100 main");

    const { result, target, events } = await create(repo, "fusion/fn-100", "FN-100");

    expect(result).toEqual({ path: target, branch: "fusion/fn-100" });
    assertRegisteredWorktree(repo, target, "fusion/fn-100");
    expect(git(repo, "git branch --list fusion/fn-100-2")).toBe("");
    const recovery = events.find((event) => event.type === "worktree:branch-collision-recovery");
    expect(recovery).toMatchObject({ target, metadata: { taskId: "FN-100", disposition: "recreate-from-startpoint" } });
    expect(Object.keys(recovery.metadata).sort()).toEqual(["disposition", "taskId"]);
  });

  it("recreates fully subsumed branch history from the pinned start point", async () => {
    const repo = setup();
    git(repo, "git checkout -qb fusion/fn-101 main");
    commit(repo, "subsumed.txt", "feat(FN-101): represented upstream");
    const branchTip = git(repo, "git rev-parse HEAD");
    git(repo, "git checkout -q main");
    git(repo, `git cherry-pick ${branchTip}`);
    const mainTip = git(repo, "git rev-parse main");

    const { target } = await create(repo, "fusion/fn-101", "FN-101");

    expect(git(repo, "git rev-parse fusion/fn-101")).toBe(mainTip);
    assertRegisteredWorktree(repo, target, "fusion/fn-101");
  });

  it("attaches a reclaimable branch and preserves exclusively task-attributed commits", async () => {
    const repo = setup();
    git(repo, "git checkout -qb fusion/fn-102 main");
    commit(repo, "own.txt", "feat(FN-102): preserve own work\n\nFusion-Task-Id: FN-102");
    const tip = git(repo, "git rev-parse HEAD");
    git(repo, "git checkout -q main");

    const { target } = await create(repo, "fusion/fn-102", "FN-102", true);

    expect(git(repo, "git rev-parse fusion/fn-102")).toBe(tip);
    expect(git(target, "git log -1 --format=%s")).toContain("feat(FN-102): preserve own work");
    expect(git(repo, "git branch --list fusion/fn-102-2")).toBe("");
  });

  it("preserves foreign and mixed unmerged histories rather than attaching or deleting", async () => {
    const repo = setup();
    for (const [branch, taskId, messages] of [
      ["fusion/next-1378", "FN-103", ["feat(FN-999): foreign work"]],
      ["fusion/fn-104", "FN-104", ["feat(FN-104): own work\n\nFusion-Task-Id: FN-104", "feat(FN-999): mixed foreign work"]],
    ] as const) {
      git(repo, `git checkout -qb ${branch} main`);
      for (const [index, message] of messages.entries()) commit(repo, `${taskId}-${index}.txt`, message);
      const tip = git(repo, "git rev-parse HEAD");
      git(repo, "git checkout -q main");
      const target = join(repo, ".worktrees", `refused-${taskId}`);
      const error = await new NativeWorktreeBackend().create({
        rootDir: repo, branch, worktreePath: target, startPoint: "main", taskId, allowSiblingBranchRename: false,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BranchConflictError);
      expect((error as BranchConflictError).collisionKind).toBe("foreign-unmerged");
      expect(git(repo, `git rev-parse ${branch}`)).toBe(tip);
      expect(existsSync(target)).toBe(false);
    }
  });

  it.each([
    ["foreign-only", ["feat(FN-999): foreign work"], false, "fusion/fn-106-2"],
    ["mixed", ["feat(FN-106): preserved own work\n\nFusion-Task-Id: FN-106", "feat(FN-999): foreign work"], true, "fusion/fn-106-3"],
  ])("routes a %s bare collision through dispatcher recovery into a fresh acquisition", async (_shape, messages, occupyFirstSibling, expectedBranch) => {
    const repo = setup();
    const branch = "fusion/fn-106";
    const missingPath = join(repo, ".worktrees", "missing-fn-106");
    git(repo, `git checkout -qb ${branch} main`);
    for (const [index, message] of messages.entries()) commit(repo, `foreign-${index}.txt`, message);
    const preservedTip = git(repo, `git rev-parse ${branch}`);
    git(repo, "git checkout -q main");
    if (occupyFirstSibling) git(repo, "git branch fusion/fn-106-2 main");

    const thrown = await new NativeWorktreeBackend().create({
      rootDir: repo,
      branch,
      worktreePath: missingPath,
      startPoint: "main",
      taskId: "FN-106",
      allowSiblingBranchRename: false,
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(BranchConflictError);
    const error = thrown as BranchConflictError;
    expect(error.collisionKind).toBe("foreign-unmerged");

    let task: any = {
      id: "FN-106",
      title: "Fresh branch recovery",
      column: "in-progress",
      branch,
      worktree: missingPath,
      baseCommitSha: "main",
      paused: true,
      pausedReason: "branch-conflict-unrecoverable",
      userPaused: false,
      columnMovedAt: "2026-09-20T00:00:00.000Z",
    };
    const store = {
      updateTask: async (_id: string, patch: Record<string, unknown>) => {
        task = { ...task, ...patch };
        return task;
      },
      updateTaskAtomic: async (_id: string, update: (current: any) => Record<string, unknown> | null) => {
        const patch = update(task);
        if (patch) task = { ...task, ...patch };
        return task;
      },
      moveTask: async (_id: string, _column: string) => {
        task = { ...task, worktree: undefined, columnMovedAt: "2026-09-20T00:01:00.000Z" };
        return task;
      },
      logEntry: async () => undefined,
    } as any;
    const audit = { database: async () => undefined, git: async () => undefined, filesystem: async () => undefined } as any;
    const handler = new BranchWorktreeAutoRecoveryHandler({ taskStore: store, runAudit: audit });
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: store,
      auditEmitter: audit,
      handlers: { issueRetry: (failure, decision, context) => handler.issueRetry(failure, decision, context) },
    });

    const decision = await dispatcher.dispatch({
      class: "branch-conflict-unrecoverable",
      taskId: task.id,
      pausedReason: "branch-conflict-unrecoverable",
      underlyingError: error,
      evidence: {
        repoDir: repo,
        branchName: branch,
        conflictingWorktreePath: missingPath,
        collisionKind: error.collisionKind,
      },
    }, { task, retryCount: 0, settings: { mode: "programmatic", maxRetries: 3 } as any });

    expect(decision.action).toBe("retry");
    expect(task.branch).toBe(expectedBranch);
    expect(task.worktree).toBeNull();
    expect(git(repo, `git rev-parse ${branch}`)).toBe(preservedTip);

    const acquired = await acquireTaskWorktree({
      task,
      rootDir: repo,
      store,
      settings: { worktreesDir: join(repo, ".worktrees") } as any,
      backend: new NativeWorktreeBackend(),
    });
    expect(acquired.branch).toBe(expectedBranch);
    expect(git(repo, `git merge-base ${expectedBranch} main`)).toBe(git(repo, "git rev-parse main"));
    expect(git(repo, `git rev-parse ${branch}`)).toBe(preservedTip);
  });

  it("refuses a live foreign checkout when the requested target path is absent", async () => {
    const repo = setup();
    git(repo, "git branch fusion/fn-105 main");
    const foreignPath = join(repo, ".worktrees", "foreign");
    git(repo, `git worktree add ${JSON.stringify(foreignPath)} fusion/fn-105`);
    const tip = git(repo, "git rev-parse fusion/fn-105");
    const target = join(repo, ".worktrees", "missing-target");

    await expect(new NativeWorktreeBackend().create({
      rootDir: repo, branch: "fusion/fn-105", worktreePath: target, startPoint: "main", taskId: "FN-105", allowSiblingBranchRename: false,
    })).rejects.toBeInstanceOf(BranchConflictError);
    expect(existsSync(target)).toBe(false);
    expect(git(repo, "git rev-parse fusion/fn-105")).toBe(tip);
  });
});

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BranchConflictError } from "../execution/branch-conflicts.js";
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
      await expect(new NativeWorktreeBackend().create({
        rootDir: repo, branch, worktreePath: target, startPoint: "main", taskId, allowSiblingBranchRename: false,
      })).rejects.toBeInstanceOf(BranchConflictError);
      expect(git(repo, `git rev-parse ${branch}`)).toBe(tip);
      expect(existsSync(target)).toBe(false);
    }
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

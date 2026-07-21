import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { installTaskWorktreeIdentityGuard } from "../../worktree-hooks.js";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

describe("pre-commit identity guard (real git)", () => {
  it("refreshes a recycled worktree owner so the reassigned task can commit", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-8400-precommit-"));
    const worktreeDir = join(rootDir, "wt-pooled");

    try {
      git(rootDir, "git init -b main");
      git(rootDir, 'git config user.email "test@example.com"');
      git(rootDir, 'git config user.name "Test"');
      writeFileSync(join(rootDir, "README.md"), "init\n");
      git(rootDir, "git add README.md && git commit -m 'init'");

      git(rootDir, "git worktree add -b fusion/fn-old wt-pooled HEAD");
      await installTaskWorktreeIdentityGuard({ worktreePath: worktreeDir, taskId: "FN-OLD" });

      // Pool preparation reuses the same linked worktree for a new task branch.
      git(worktreeDir, "git checkout -B fusion/fn-new main");
      writeFileSync(join(worktreeDir, "new-owner.txt"), "new owner\n");
      git(worktreeDir, "git add new-owner.txt");

      const staleOwnerCommit = spawnSync("git", ["commit", "-m", "fix(FN-NEW): blocked by stale owner"], {
        cwd: worktreeDir,
        encoding: "utf-8",
      });
      expect(staleOwnerCommit.status).toBe(1);
      expect(`${staleOwnerCommit.stderr}${staleOwnerCommit.stdout}`).toContain(
        "fusion: refusing commit — worktree owns FN-OLD but HEAD is fusion/fn-new",
      );

      await installTaskWorktreeIdentityGuard({ worktreePath: worktreeDir, taskId: "FN-NEW" });

      const refreshedOwnerCommit = spawnSync("git", ["commit", "-m", "fix(FN-NEW): accepted after owner refresh"], {
        cwd: worktreeDir,
        encoding: "utf-8",
      });
      expect(refreshedOwnerCommit.status).toBe(0);

      const taskIdPathRaw = git(worktreeDir, "git rev-parse --git-path fusion-task-id");
      const taskIdPath = resolve(worktreeDir, taskIdPathRaw);
      expect(readFileSync(taskIdPath, "utf-8").trim()).toBe("FN-NEW");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses per-worktree metadata so a shared stale hook still allows sibling owner commits", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-5266-precommit-"));
    const staleDir = join(rootDir, "wt-stale");
    const activeDir = join(rootDir, "wt-active");

    try {
      git(rootDir, "git init -b main");
      git(rootDir, 'git config user.email "test@example.com"');
      git(rootDir, 'git config user.name "Test"');
      writeFileSync(join(rootDir, "README.md"), "init\n");
      git(rootDir, "git add README.md && git commit -m 'init'");

      git(rootDir, "git worktree add -b fusion/fn-stale wt-stale HEAD");
      await installTaskWorktreeIdentityGuard({ worktreePath: staleDir, taskId: "FN-STALE" });

      git(rootDir, "git worktree add -b fusion/fn-active wt-active HEAD");
      await installTaskWorktreeIdentityGuard({ worktreePath: activeDir, taskId: "FN-ACTIVE" });

      const staleHookRawPath = git(staleDir, "git rev-parse --git-path hooks/pre-commit");
      const staleHookPath = isAbsolute(staleHookRawPath) ? staleHookRawPath : resolve(staleDir, staleHookRawPath);
      const activeHookRawPath = git(activeDir, "git rev-parse --git-path hooks/pre-commit");
      const activeHookPath = isAbsolute(activeHookRawPath) ? activeHookRawPath : resolve(activeDir, activeHookRawPath);
      expect(activeHookPath).toBe(staleHookPath);

      const activeTaskIdPathRaw = git(activeDir, "git rev-parse --git-path fusion-task-id");
      const activeTaskIdPath = isAbsolute(activeTaskIdPathRaw) ? activeTaskIdPathRaw : resolve(activeDir, activeTaskIdPathRaw);
      // Mirror the common on-disk state where fusion-task-id preserves the original uppercase task id.
      await writeFile(activeTaskIdPath, "FN-ACTIVE\n", "utf-8");
      expect(readFileSync(activeTaskIdPath, "utf-8")).toBe("FN-ACTIVE\n");

      writeFileSync(join(activeDir, "active.txt"), "active branch\n");
      git(activeDir, "git add active.txt");
      git(activeDir, "git commit -m 'feat(FN-ACTIVE): owner commit'");

      writeFileSync(join(staleDir, "stale.txt"), "stale branch\n");
      git(staleDir, "git add stale.txt");
      git(staleDir, "git commit -m 'feat(FN-STALE): owner commit'");

      git(activeDir, "git checkout -b fusion/fn-other");
      writeFileSync(join(activeDir, "other.txt"), "other branch\n");
      git(activeDir, "git add other.txt");

      const blockedCommit = spawnSync("git", ["commit", "-m", "feat(FN-ACTIVE): blocked"], {
        cwd: activeDir,
        encoding: "utf-8",
      });
      expect(blockedCommit.status).not.toBe(0);
      expect(`${blockedCommit.stderr}${blockedCommit.stdout}`).toContain(
        "fusion: refusing commit — worktree owns FN-ACTIVE but HEAD is fusion/fn-other",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("FN-5271 accepts canonical lowercase task branches when fusion-task-id casing drifts, while still blocking other branches", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-5271-precommit-"));
    const worktreeDir = join(rootDir, "wt-fn-5271");

    try {
      git(rootDir, "git init -b main");
      git(rootDir, 'git config user.email "test@example.com"');
      git(rootDir, 'git config user.name "Test"');
      writeFileSync(join(rootDir, "README.md"), "init\n");
      git(rootDir, "git add README.md && git commit -m 'init'");

      git(rootDir, "git worktree add -b fusion/fn-5271 wt-fn-5271 HEAD");
      await installTaskWorktreeIdentityGuard({ worktreePath: worktreeDir, taskId: "FN-5271" });

      const taskIdPathRaw = git(worktreeDir, "git rev-parse --git-path fusion-task-id");
      const taskIdPath = isAbsolute(taskIdPathRaw) ? taskIdPathRaw : resolve(worktreeDir, taskIdPathRaw);
      await writeFile(taskIdPath, "FN-5210\n", "utf-8");

      git(worktreeDir, "git checkout -B fusion/fn-5210");
      writeFileSync(join(worktreeDir, "owner.txt"), "owner branch\n");
      git(worktreeDir, "git add owner.txt");

      const allowedCommit = spawnSync("git", ["commit", "-m", "fix(FN-5210): allow canonical lowercase branch"], {
        cwd: worktreeDir,
        encoding: "utf-8",
      });
      expect(allowedCommit.status).toBe(0);

      git(worktreeDir, "git checkout -B fusion/fn-other");
      writeFileSync(join(worktreeDir, "other.txt"), "other branch\n");
      git(worktreeDir, "git add other.txt");

      const blockedCommit = spawnSync("git", ["commit", "-m", "fix(FN-5210): blocked other branch"], {
        cwd: worktreeDir,
        encoding: "utf-8",
      });
      expect(blockedCommit.status).not.toBe(0);
      expect(`${blockedCommit.stderr}${blockedCommit.stdout}`).toContain(
        "fusion: refusing commit — worktree owns FN-5210 but HEAD is fusion/fn-other",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("blocks misbound task-branch commits while allowing owner and step branches", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-4948-precommit-"));
    const worktreeDir = join(rootDir, "wt-fn-a");
    const rootFile = join(rootDir, "root.txt");

    try {
      git(rootDir, "git init -b main");
      git(rootDir, 'git config user.email "test@example.com"');
      git(rootDir, 'git config user.name "Test"');
      writeFileSync(join(rootDir, "README.md"), "init\n");
      git(rootDir, "git add README.md && git commit -m 'init'");

      git(rootDir, "git worktree add -b fusion/fn-a wt-fn-a HEAD");

      await installTaskWorktreeIdentityGuard({ worktreePath: worktreeDir, taskId: "FN-A" });

      const taskIdPath = git(worktreeDir, "git rev-parse --git-path fusion-task-id");
      const taskIdFile = readFileSync(isAbsolute(taskIdPath) ? taskIdPath : resolve(worktreeDir, taskIdPath), "utf-8");
      expect(taskIdFile.trim()).toBe("FN-A");

      const hookRawPath = git(worktreeDir, "git rev-parse --git-path hooks/pre-commit");
      const hookPath = isAbsolute(hookRawPath) ? hookRawPath : resolve(worktreeDir, hookRawPath);
      chmodSync(hookPath, 0o755);

      git(worktreeDir, "git checkout -b fusion/fn-b");
      writeFileSync(join(worktreeDir, "misbound.txt"), "wrong branch\n");
      git(worktreeDir, "git add misbound.txt");

      const blockedCommit = spawnSync("git", ["commit", "-m", "feat(FN-B): blocked"], { cwd: worktreeDir, encoding: "utf-8" });
      expect(blockedCommit.status).not.toBe(0);
      expect(`${blockedCommit.stderr}${blockedCommit.stdout}`).toContain(
        "fusion: refusing commit — worktree owns FN-A but HEAD is fusion/fn-b",
      );

      git(worktreeDir, "git checkout fusion/fn-a");
      writeFileSync(join(worktreeDir, "owned.txt"), "owned branch\n");
      git(worktreeDir, "git add owned.txt");
      git(worktreeDir, "git commit -m 'feat(FN-A): allowed owner commit'");

      git(worktreeDir, "git checkout -b fusion/step-1-lemon-lotus");
      writeFileSync(join(worktreeDir, "step.txt"), "step branch\n");
      git(worktreeDir, "git add step.txt");
      git(worktreeDir, "git commit -m 'test(FN-A): step branch commit'");

      writeFileSync(rootFile, "root commit\n");
      git(rootDir, "git add root.txt");
      git(rootDir, "git commit -m 'chore: root commit succeeds without task hook'");

      const currentStepSha = git(worktreeDir, "git rev-parse HEAD");
      git(worktreeDir, `${"git checkout --detach "}${currentStepSha}`);
      writeFileSync(join(worktreeDir, "detached.txt"), "detached\n");
      git(worktreeDir, "git add detached.txt");

      const detachedCommit = spawnSync("git", ["commit", "-m", "test(FN-A): detached blocked"], {
        cwd: worktreeDir,
        encoding: "utf-8",
      });
      expect(detachedCommit.status).not.toBe(0);
      expect(`${detachedCommit.stderr}${detachedCommit.stdout}`).toContain(
        "fusion: refusing commit — worktree owns FN-A but HEAD is detached",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);
});

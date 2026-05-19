import { mkdtempSync, writeFileSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildIdentityGuardHook, installTaskWorktreeIdentityGuard } from "../worktree-hooks.js";

describe("worktree-hooks", () => {
  it("builds a hook with expected guard lines", () => {
    const hook = buildIdentityGuardHook("FN-1");
    expect(hook).toContain("#!/bin/sh");
    expect(hook).toContain("TASK_FILE=$(git rev-parse --git-path fusion-task-id)");
    expect(hook).toContain('EXPECTED_BRANCH="fusion/fn-1"');
    expect(hook).toContain("fusion: refusing commit — worktree owns");
    expect(hook).toContain("fusion/step-[0-9]*-[a-z0-9-]*");
  });

  it("installs metadata and pre-commit hook in linked worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-hook-root-"));
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });

    const wt = join(root, "wt");
    execFileSync("git", ["worktree", "add", "-b", "fusion/fn-1", wt], { cwd: root });

    await installTaskWorktreeIdentityGuard({ worktreePath: wt, taskId: "FN-1" });

    const taskIdRaw = execFileSync("git", ["rev-parse", "--git-path", "fusion-task-id"], { cwd: wt, encoding: "utf-8" }).trim();
    const taskIdPath = isAbsolute(taskIdRaw) ? taskIdRaw : resolve(wt, taskIdRaw);
    const hookRaw = execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], {
      cwd: wt,
      encoding: "utf-8",
    }).trim();
    const hookPath = isAbsolute(hookRaw) ? hookRaw : resolve(wt, hookRaw);

    expect((await readFile(taskIdPath, "utf-8")).trim()).toBe("FN-1");
    await access(hookPath);
    const mode = (await stat(hookPath)).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("is idempotent when run twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-hook-idem-"));
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });

    const wt = join(root, "wt");
    execFileSync("git", ["worktree", "add", "-b", "fusion/fn-2", wt], { cwd: root });

    await installTaskWorktreeIdentityGuard({ worktreePath: wt, taskId: "FN-2" });
    const hookRaw = execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], {
      cwd: wt,
      encoding: "utf-8",
    }).trim();
    const hookPath = isAbsolute(hookRaw) ? hookRaw : resolve(wt, hookRaw);
    const first = (await stat(hookPath)).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    await installTaskWorktreeIdentityGuard({ worktreePath: wt, taskId: "FN-2" });
    const second = (await stat(hookPath)).mtimeMs;
    expect(second).toBe(first);
  });

  it("throws when not in git worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-hook-bad-"));
    await expect(installTaskWorktreeIdentityGuard({ worktreePath: dir, taskId: "FN-3" })).rejects.toThrow(
      "Failed to resolve git path",
    );
  });

  describe("hook execution", () => {
    function runHook(wt: string, hook: string, metadata: string): { exitCode: number; stderr: string } {
      const metaRaw = execFileSync("git", ["rev-parse", "--git-path", "fusion-task-id"], { cwd: wt, encoding: "utf-8" }).trim();
      const metaPath = isAbsolute(metaRaw) ? metaRaw : resolve(wt, metaRaw);
      writeFileSync(metaPath, metadata);

      const hookPath = join(wt, "pre-commit-test.sh");
      writeFileSync(hookPath, hook, { mode: 0o755 });

      try {
        execFileSync("sh", [hookPath], { cwd: wt, encoding: "utf-8" });
        return { exitCode: 0, stderr: "" };
      } catch (e: any) {
        return { exitCode: e.status ?? 1, stderr: e.stderr ?? "" };
      }
    }

    it("passes when uppercase metadata matches lowercase branch", () => {
      const root = mkdtempSync(join(tmpdir(), "wt-hook-case-"));
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });

      const wt = join(root, "wt");
      execFileSync("git", ["worktree", "add", "-b", "fusion/fn-091", wt], { cwd: root });

      const hook = buildIdentityGuardHook("fn-091");
      const result = runHook(wt, hook, "FN-091");
      expect(result.exitCode).toBe(0);
    });

    it("passes when lowercase metadata matches lowercase branch", () => {
      const root = mkdtempSync(join(tmpdir(), "wt-hook-low-"));
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });

      const wt = join(root, "wt");
      execFileSync("git", ["worktree", "add", "-b", "fusion/fn-091", wt], { cwd: root });

      const hook = buildIdentityGuardHook("FN-091");
      const result = runHook(wt, hook, "fn-091");
      expect(result.exitCode).toBe(0);
    });

    it("fails when metadata does not match branch", () => {
      const root = mkdtempSync(join(tmpdir(), "wt-hook-mismatch-"));
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });

      const wt = join(root, "wt");
      execFileSync("git", ["worktree", "add", "-b", "fusion/fn-092", wt], { cwd: root });

      const hook = buildIdentityGuardHook("FN-091");
      const result = runHook(wt, hook, "FN-091");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree owns FN-091 but HEAD is fusion/fn-092");
    });

    it("passes for step branches on the allowlist", () => {
      const root = mkdtempSync(join(tmpdir(), "wt-hook-step-"));
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });

      const wt = join(root, "wt");
      execFileSync("git", ["worktree", "add", "-b", "fusion/step-1-do-stuff", wt], { cwd: root });

      const hook = buildIdentityGuardHook("FN-091");
      const result = runHook(wt, hook, "FN-091");
      expect(result.exitCode).toBe(0);
    });
  });
});

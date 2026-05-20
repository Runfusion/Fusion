import { mkdtempSync, writeFileSync } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { buildCommitMsgTrailerHook, buildIdentityGuardHook, installTaskWorktreeIdentityGuard } from "../worktree-hooks.js";

describe("worktree-hooks", () => {
  it("builds a hook with expected guard lines", () => {
    const hook = buildIdentityGuardHook();
    expect(hook).toContain("#!/bin/sh");
    expect(hook).toContain("TASK_FILE=$(git rev-parse --git-path fusion-task-id)");
    expect(hook).toContain('EXPECTED_BRANCH="fusion/$(printf');
    expect(hook).toContain("tr '[:upper:]' '[:lower:]'");
    expect(hook).toContain('HEAD_BRANCH_CANONICAL=$(printf');
    expect(hook).toContain('EXPECTED_BRANCH_CANONICAL=$(printf');
    expect(hook).toContain("fusion: refusing commit — worktree owns");
    expect(hook).toContain("fusion/step-[0-9]*-[a-z0-9-]*");
    // Hook must not contain a baked task-specific branch default
    expect(hook).not.toContain('EXPECTED_BRANCH="fusion/fn-1"');
  });

  it("builds commit-msg trailer hook with expected lines", () => {
    const hook = buildCommitMsgTrailerHook("FN-42");
    expect(hook).toContain("#!/bin/sh");
    expect(hook).toContain("TASK_FILE=$(git rev-parse --git-path fusion-task-id)");
    expect(hook).toContain("[ -f \"$TASK_FILE\" ] || exit 0");
    expect(hook).toContain("[ -n \"$TASK_ID\" ] || exit 0");
    expect(hook).toContain("git interpret-trailers");
    expect(hook).toContain("--in-place");
    expect(hook).toContain("--if-exists doNothing");
    expect(hook).toContain("--trailer \"$TRAILER_NAME: $TASK_ID\"");
    expect(hook).toContain("s/^FN-//i");
  });

  it("parameterizes commit-msg hook for custom prefix and trailer name", () => {
    const hook = buildCommitMsgTrailerHook("KB-9", { taskPrefix: "KB", trailerName: "Task-Id" });
    expect(hook).toContain('PREFIX="KB"');
    expect(hook).toContain('TRAILER_NAME="Task-Id"');
    expect(hook).toContain("s/^KB-//i");
  });

  it("installs metadata and pre-commit + commit-msg hooks in linked worktree", async () => {
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
    const preCommitRaw = execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], {
      cwd: wt,
      encoding: "utf-8",
    }).trim();
    const preCommitPath = isAbsolute(preCommitRaw) ? preCommitRaw : resolve(wt, preCommitRaw);
    const commitMsgRaw = execFileSync("git", ["rev-parse", "--git-path", "hooks/commit-msg"], {
      cwd: wt,
      encoding: "utf-8",
    }).trim();
    const commitMsgPath = isAbsolute(commitMsgRaw) ? commitMsgRaw : resolve(wt, commitMsgRaw);

    expect((await readFile(taskIdPath, "utf-8")).trim()).toBe("FN-1");
    await access(preCommitPath);
    await access(commitMsgPath);
    expect((await stat(preCommitPath)).mode & 0o777).toBe(0o755);
    expect((await stat(commitMsgPath)).mode & 0o777).toBe(0o755);
    expect(await readFile(commitMsgPath, "utf-8")).toContain('git interpret-trailers');
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
    const preCommitRaw = execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], {
      cwd: wt,
      encoding: "utf-8",
    }).trim();
    const preCommitPath = isAbsolute(preCommitRaw) ? preCommitRaw : resolve(wt, preCommitRaw);
    const commitMsgRaw = execFileSync("git", ["rev-parse", "--git-path", "hooks/commit-msg"], {
      cwd: wt,
      encoding: "utf-8",
    }).trim();
    const commitMsgPath = isAbsolute(commitMsgRaw) ? commitMsgRaw : resolve(wt, commitMsgRaw);
    const firstPreCommit = (await stat(preCommitPath)).mtimeMs;
    const firstCommitMsg = (await stat(commitMsgPath)).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    await installTaskWorktreeIdentityGuard({ worktreePath: wt, taskId: "FN-2" });
    const secondPreCommit = (await stat(preCommitPath)).mtimeMs;
    const secondCommitMsg = (await stat(commitMsgPath)).mtimeMs;
    expect(secondPreCommit).toBe(firstPreCommit);
    expect(secondCommitMsg).toBe(firstCommitMsg);
  });

  it("skips commit-msg install when disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-hook-disabled-"));
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });

    const wt = join(root, "wt");
    execFileSync("git", ["worktree", "add", "-b", "fusion/fn-3", wt], { cwd: root });

    await installTaskWorktreeIdentityGuard({ worktreePath: wt, taskId: "FN-3", commitMsgHookEnabled: false });

    const commitMsgRaw = execFileSync("git", ["rev-parse", "--git-path", "hooks/commit-msg"], {
      cwd: wt,
      encoding: "utf-8",
    }).trim();
    const commitMsgPath = isAbsolute(commitMsgRaw) ? commitMsgRaw : resolve(wt, commitMsgRaw);
    await expect(access(commitMsgPath)).rejects.toBeDefined();
  });

  it("refuses to overwrite existing commit-msg hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-hook-existing-"));
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });

    const wt = join(root, "wt");
    execFileSync("git", ["worktree", "add", "-b", "fusion/fn-4", wt], { cwd: root });

    const commitMsgRaw = execFileSync("git", ["rev-parse", "--git-path", "hooks/commit-msg"], {
      cwd: wt,
      encoding: "utf-8",
    }).trim();
    const commitMsgPath = isAbsolute(commitMsgRaw) ? commitMsgRaw : resolve(wt, commitMsgRaw);
    await writeFile(commitMsgPath, "#!/bin/sh\necho custom\n", "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await installTaskWorktreeIdentityGuard({ worktreePath: wt, taskId: "FN-4" });
    expect(await readFile(commitMsgPath, "utf-8")).toContain("echo custom");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
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

      const hook = buildIdentityGuardHook();
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

      const hook = buildIdentityGuardHook();
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

      const hook = buildIdentityGuardHook();
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

      const hook = buildIdentityGuardHook();
      const result = runHook(wt, hook, "FN-091");
      expect(result.exitCode).toBe(0);
    });

    it("passes when metadata file is missing", () => {
      const root = mkdtempSync(join(tmpdir(), "wt-hook-missing-"));
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });

      const wt = join(root, "wt");
      execFileSync("git", ["worktree", "add", "-b", "fusion/fn-099", wt], { cwd: root });

      const hook = buildIdentityGuardHook();
      const metaRaw = execFileSync("git", ["rev-parse", "--git-path", "fusion-task-id"], { cwd: wt, encoding: "utf-8" }).trim();
      const metaPath = isAbsolute(metaRaw) ? metaRaw : resolve(wt, metaRaw);
      // Ensure metadata file does not exist
      try {
        execFileSync("rm", [metaPath], { cwd: wt });
      } catch {
        // may already be missing
      }

      const hookPath = join(wt, "pre-commit-test.sh");
      writeFileSync(hookPath, hook, { mode: 0o755 });

      try {
        execFileSync("sh", [hookPath], { cwd: wt, encoding: "utf-8" });
        expect(true).toBe(true);
      } catch (e: any) {
        expect(e.status).toBe(0);
      }
    });

    it("reports detached HEAD and rejects commit", () => {
      const root = mkdtempSync(join(tmpdir(), "wt-hook-detached-"));
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });

      const wt = join(root, "wt");
      execFileSync("git", ["worktree", "add", "-b", "fusion/fn-100", wt], { cwd: root });
      // Detach HEAD
      execFileSync("git", ["checkout", "--detach"], { cwd: wt });

      const hook = buildIdentityGuardHook();
      const result = runHook(wt, hook, "FN-100");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree owns FN-100 but HEAD is detached");
    });
  });

  it("shares identical task-agnostic hook content across linked worktrees", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-hook-shared-"));
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });

    const wtA = join(root, "wt-a");
    const wtB = join(root, "wt-b");
    execFileSync("git", ["worktree", "add", "-b", "fusion/fn-142", wtA], { cwd: root });
    execFileSync("git", ["worktree", "add", "-b", "fusion/fn-143", wtB], { cwd: root });

    await installTaskWorktreeIdentityGuard({ worktreePath: wtA, taskId: "FN-142" });
    const hookRawA = execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], {
      cwd: wtA,
      encoding: "utf-8",
    }).trim();
    const hookPathA = isAbsolute(hookRawA) ? hookRawA : resolve(wtA, hookRawA);
    const contentA = await readFile(hookPathA, "utf-8");

    await installTaskWorktreeIdentityGuard({ worktreePath: wtB, taskId: "FN-143" });
    const hookRawB = execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], {
      cwd: wtB,
      encoding: "utf-8",
    }).trim();
    const hookPathB = isAbsolute(hookRawB) ? hookRawB : resolve(wtB, hookRawB);
    const contentB = await readFile(hookPathB, "utf-8");

    // Shared hook content must be identical because the hook is task-agnostic
    expect(contentA).toBe(contentB);
    expect(contentA).not.toContain("fusion/fn-142");
    expect(contentA).not.toContain("fusion/fn-143");

    // Both worktrees must pass on their own branches using the shared hook
    const resultA = (() => {
      const metaRaw = execFileSync("git", ["rev-parse", "--git-path", "fusion-task-id"], { cwd: wtA, encoding: "utf-8" }).trim();
      const metaPath = isAbsolute(metaRaw) ? metaRaw : resolve(wtA, metaRaw);
      writeFileSync(metaPath, "FN-142");
      const hookPath = join(wtA, "pre-commit-test.sh");
      writeFileSync(hookPath, contentA, { mode: 0o755 });
      try {
        execFileSync("sh", [hookPath], { cwd: wtA, encoding: "utf-8" });
        return { exitCode: 0, stderr: "" };
      } catch (e: any) {
        return { exitCode: e.status ?? 1, stderr: e.stderr ?? "" };
      }
    })();
    expect(resultA.exitCode).toBe(0);

    const resultB = (() => {
      const metaRaw = execFileSync("git", ["rev-parse", "--git-path", "fusion-task-id"], { cwd: wtB, encoding: "utf-8" }).trim();
      const metaPath = isAbsolute(metaRaw) ? metaRaw : resolve(wtB, metaRaw);
      writeFileSync(metaPath, "FN-143");
      const hookPath = join(wtB, "pre-commit-test.sh");
      writeFileSync(hookPath, contentB, { mode: 0o755 });
      try {
        execFileSync("sh", [hookPath], { cwd: wtB, encoding: "utf-8" });
        return { exitCode: 0, stderr: "" };
      } catch (e: any) {
        return { exitCode: e.status ?? 1, stderr: e.stderr ?? "" };
      }
    })();
    expect(resultB.exitCode).toBe(0);
  });
});

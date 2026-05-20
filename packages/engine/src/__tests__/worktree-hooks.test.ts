import { mkdtempSync } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { buildCommitMsgTrailerHook, buildIdentityGuardHook, installTaskWorktreeIdentityGuard } from "../worktree-hooks.js";

describe("worktree-hooks", () => {
  it("builds a hook with expected guard lines", () => {
    const hook = buildIdentityGuardHook("FN-1");
    expect(hook).toContain("#!/bin/sh");
    expect(hook).toContain("TASK_FILE=$(git rev-parse --git-path fusion-task-id)");
    expect(hook).toContain("tr '[:upper:]' '[:lower:]'");
    expect(hook).toContain(`EXPECTED_BRANCH="fusion/$(printf '%s' "$WORKTREE_TASK_ID" | tr '[:upper:]' '[:lower:]')"`);
    expect(hook).toContain("fusion: refusing commit — worktree owns");
    expect(hook).toContain("fusion/step-[0-9]*-[a-z0-9-]*");
    expect(hook).not.toContain("fusion/fn-1");
    expect(hook).not.toContain("FN-1");
    expect(hook).not.toContain("fn-1");
    expect(hook).not.toMatch(/if \[ "\$WORKTREE_TASK_ID" !=/);
  });

  it("does not vary by install-time task id", () => {
    const firstHook = buildIdentityGuardHook("FN-1");
    const secondHook = buildIdentityGuardHook("FN-9999");

    expect(firstHook).toBe(secondHook);
    expect(firstHook).not.toContain("FN-1");
    expect(firstHook).not.toContain("FN-9999");
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
});

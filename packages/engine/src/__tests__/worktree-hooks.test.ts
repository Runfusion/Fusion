import { mkdtempSync } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { buildCommitMsgTrailerHook, buildIdentityGuardHook, installTaskWorktreeIdentityGuard } from "../worktree/worktree-hooks.js";

describe("worktree-hooks", () => {
  it("builds a hook with expected guard lines", () => {
    const hook = buildIdentityGuardHook("FN-5210");
    expect(hook).toContain("#!/bin/sh");
    expect(hook).toContain("TASK_FILE=$(git rev-parse --git-path fusion-task-id)");
    expect(hook).toContain('EXPECTED_BRANCH="fusion/fn-5210"');
    expect(hook).toContain("tr '[:upper:]' '[:lower:]'");
    expect(hook).toContain('EXPECTED_BRANCH="fusion/$(printf \'%s\' \"$WORKTREE_TASK_ID\" | tr \'[:upper:]\' \'[:lower:]\')"');
    expect(hook).toContain('HEAD_BRANCH_CANONICAL=$(printf \'%s\' "$HEAD_BRANCH" | tr \'[:upper:]\' \'[:lower:]\')');
    expect(hook).toContain('EXPECTED_BRANCH_CANONICAL=$(printf \'%s\' "$EXPECTED_BRANCH" | tr \'[:upper:]\' \'[:lower:]\')');
    expect(hook).toContain("fusion: refusing commit — worktree owns");
    expect(hook).toContain("fusion/step-[0-9]*-[a-z0-9-]*");
    expect(hook).toContain('!= "fn-5210"');
    expect(hook).toContain("# Keep this canonicalized in lockstep with canonicalFusionBranchName(taskId)");
    expect(hook).not.toContain("FN-5210");
  });

  it.each([
    ["FN-1", "fusion/fn-1"],
    ["FN-9999", "fusion/fn-9999"],
  ])("uses the install-time task id as the canonical default branch for %s", (taskId, expectedBranch) => {
    const hook = buildIdentityGuardHook(taskId);

    expect(hook).toContain(`EXPECTED_BRANCH=\"${expectedBranch}\"`);
  });

  it("honors the merger bypass marker on detached HEAD before computing EXPECTED_BRANCH", () => {
    const hook = buildIdentityGuardHook("FN-5483");
    const bypassIndex = hook.indexOf('FUSION_MERGER_BYPASS_IDENTITY_GUARD:-');
    const expectedBranchIndex = hook.indexOf('EXPECTED_BRANCH=');
    const refuseIndex = hook.indexOf('refusing commit');

    expect(bypassIndex).toBeGreaterThan(-1);
    // bypass check must come before the branch comparison and before the refusal printf
    expect(bypassIndex).toBeLessThan(expectedBranchIndex);
    expect(bypassIndex).toBeLessThan(refuseIndex);
    // bypass must require the exact value "1" — not a non-empty truthy check
    expect(hook).toContain('"${FUSION_MERGER_BYPASS_IDENTITY_GUARD:-}" = "1"');
    // bypass arm must short-circuit with exit 0 before reaching the refusal path
    const bypassBlock = hook.slice(bypassIndex, expectedBranchIndex);
    expect(bypassBlock).toContain("exit 0");
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
    expect(hook).toContain("--if-exists addIfDifferent");
    expect(hook).toContain('CO_AUTHOR_TRAILER="Co-authored-by: Fusion <noreply@runfusion.ai>"');
    expect(hook).toContain("s/^FN-//i");
  });

  it("parameterizes commit-msg co-author trailer and omits it when disabled", () => {
    const customHook = buildCommitMsgTrailerHook("FN-42", {
      commitAuthorName: "Fusion Bot",
      commitAuthorEmail: "bot@example.com",
    });
    expect(customHook).toContain('CO_AUTHOR_TRAILER="Co-authored-by: Fusion Bot <bot@example.com>"');
    expect(customHook).toContain("--if-exists addIfDifferent");

    const disabledHook = buildCommitMsgTrailerHook("FN-42", { commitAuthorEnabled: false });
    expect(disabledHook).not.toContain("Co-authored-by:");
    expect(disabledHook).not.toContain("addIfDifferent");
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

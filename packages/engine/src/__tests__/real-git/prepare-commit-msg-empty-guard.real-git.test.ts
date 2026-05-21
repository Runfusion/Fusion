import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { installTaskWorktreeIdentityGuard } from "../../worktree-hooks.js";

function git(dir: string, cmd: string): { stdout: string; stderr: string; status: number | null } {
  try {
    const stdout = execSync(cmd, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
    return { stdout, stderr: "", status: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "", status: err.status ?? null };
  }
}

describe("prepare-commit-msg empty-commit guard (real git, FN-5345/FN-5377)", () => {
  it("refuses --allow-empty in fusion task worktrees, but allows amend and real commits", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-5345-empty-guard-"));
    const worktreeDir = join(rootDir, "wt");

    try {
      git(rootDir, "git init -b main");
      git(rootDir, 'git config user.email "t@t"');
      git(rootDir, 'git config user.name "t"');
      writeFileSync(join(rootDir, "README.md"), "init\n");
      git(rootDir, "git add README.md");
      git(rootDir, "git commit -m 'init'");

      git(rootDir, "git worktree add -b fusion/fn-5345 wt HEAD");
      await installTaskWorktreeIdentityGuard({
        worktreePath: worktreeDir,
        taskId: "FN-5345",
      });

      // Real commit succeeds.
      writeFileSync(join(worktreeDir, "real.txt"), "real\n");
      git(worktreeDir, "git add real.txt");
      const real = git(worktreeDir, "git commit -m 'feat(FN-5345): real'");
      expect(real.status).toBe(0);

      // --allow-empty with new message is REFUSED.
      const empty = git(worktreeDir, "git commit --allow-empty -m 'feat(FN-5345): empty handoff'");
      expect(empty.status).not.toBe(0);
      expect(empty.stderr).toContain("refusing empty commit");
      expect(empty.stderr).toContain("FN-5345/FN-5377");

      // Review-finding regression: a commit message containing the substring
      // '--amend' must NOT trick the parent-cmd tokenized check into allowing
      // the empty commit. The original glob pattern (*' --amend'*) would have
      // matched this; the tokenized check rejects it.
      const sneaky = git(
        worktreeDir,
        "git commit --allow-empty -m 'feat(FN-5345): fix --amend handling'",
      );
      expect(sneaky.status).not.toBe(0);
      expect(sneaky.stderr).toContain("refusing empty commit");

      // --amend --no-edit (no staged changes, amend HEAD) is ALLOWED.
      const amendNoEdit = git(worktreeDir, "git commit --amend --no-edit");
      expect(amendNoEdit.status).toBe(0);

      // --amend -m "..." (no staged changes, reword) is ALLOWED.
      const amendReword = git(worktreeDir, "git commit --amend -m 'feat(FN-5345): reworded'");
      expect(amendReword.status).toBe(0);

      // Outside fusion worktrees (no fusion-task-id metadata), --allow-empty works normally.
      const outside = git(rootDir, "git commit --allow-empty -m 'chore: legit empty in root'");
      expect(outside.status).toBe(0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);
});

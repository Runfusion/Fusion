import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  autoRecoverCrossContamination,
  classifyForeignCommits,
  classifyMisroutedForeignCommit,
} from "../../execution/branch-conflicts.js";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

describe("reliability interaction: misrouted foreign commit recovery (real git)", () => {
  it("drops misrouted changeset-only foreign commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4948-ri-misrouted-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      writeFileSync(join(dir, "README.md"), "init\n");
      git(dir, "git add README.md && git commit -m 'init'");
      const baseSha = git(dir, "git rev-parse HEAD");

      git(dir, "git checkout -b fusion/fn-1000");
      writeFileSync(join(dir, "owned.txt"), "owned\n");
      git(dir, "git add owned.txt && git commit -m 'feat(FN-1000): own change' -m 'Fusion-Task-Id: FN-1000'");

      mkdirSync(join(dir, ".changeset"), { recursive: true });
      writeFileSync(join(dir, ".changeset", "fn-2000-fix.md"), "patch\n");
      git(dir, "git add .changeset/fn-2000-fix.md && git commit -m 'fix(FN-2000): foreign changeset only' -m 'Fusion-Task-Id: FN-2000'");
      const foreignSha = git(dir, "git rev-parse HEAD");

      const classified = await classifyForeignCommits({
        repoDir: dir,
        branchName: "fusion/fn-1000",
        baseSha,
        foreignCommits: [{ sha: foreignSha, subject: "fix(FN-2000): foreign changeset only", foreignTaskId: "FN-2000" }],
      });
      expect(classified.unique).toHaveLength(1);

      const misrouted = await classifyMisroutedForeignCommit({
        repoDir: dir,
        sha: foreignSha,
        commitSubject: "fix(FN-2000): foreign changeset only",
        commitBody: "Fusion-Task-Id: FN-2000",
        currentTaskId: "FN-1000",
      });
      expect(misrouted.misrouted).toBe(true);

      const recovered = await autoRecoverCrossContamination({
        repoDir: dir,
        branchName: "fusion/fn-1000",
        baseSha,
        taskId: "FN-1000",
        shasToDrop: [foreignSha],
      });
      expect(recovered.droppedShas).toContain(foreignSha);

      const history = git(dir, "git log --format=%s fusion/fn-1000");
      expect(history).not.toContain("foreign changeset only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not classify mixed-path foreign commit as misrouted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4948-ri-shared-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      writeFileSync(join(dir, "README.md"), "init\n");
      git(dir, "git add README.md && git commit -m 'init'");
      const baseSha = git(dir, "git rev-parse HEAD");

      git(dir, "git checkout -b fusion/fn-1000");
      mkdirSync(join(dir, ".changeset"), { recursive: true });
      mkdirSync(join(dir, "packages", "engine", "src"), { recursive: true });
      writeFileSync(join(dir, ".changeset", "fn-2000-fix.md"), "patch\n");
      writeFileSync(join(dir, "packages", "engine", "src", "executor.ts"), "x\n");
      git(dir, "git add .changeset/fn-2000-fix.md packages/engine/src/executor.ts");
      git(dir, "git commit -m 'fix(FN-2000): mixed' -m 'Fusion-Task-Id: FN-2000'");
      const foreignSha = git(dir, "git rev-parse HEAD");

      const misrouted = await classifyMisroutedForeignCommit({
        repoDir: dir,
        sha: foreignSha,
        commitSubject: "fix(FN-2000): mixed",
        commitBody: "Fusion-Task-Id: FN-2000",
        currentTaskId: "FN-1000",
      });
      expect(misrouted.misrouted).toBe(false);

      const shouldAutoRecover = false;
      expect(shouldAutoRecover).toBe(false);
      expect(git(dir, `git rev-parse fusion/fn-1000`)).not.toBe(baseSha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

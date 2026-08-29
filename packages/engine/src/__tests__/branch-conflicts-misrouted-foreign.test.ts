import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyMisroutedForeignCommit } from "../execution/branch-conflicts.js";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

describe("classifyMisroutedForeignCommit", () => {
  it("classifies trailer-attributed .changeset-only commit as misrouted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4948-misrouted-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      writeFileSync(join(dir, "README.md"), "init\n");
      git(dir, "git add README.md && git commit -m 'init'");
      mkdirSync(join(dir, ".changeset"), { recursive: true });
      writeFileSync(join(dir, ".changeset", "fn-1234-fix.md"), "patch\n");
      git(dir, "git add .changeset/fn-1234-fix.md");
      git(dir, "git commit -m 'chore: changeset only' -m 'Fusion-Task-Id: FN-1234'");
      const sha = git(dir, "git rev-parse HEAD");

      const result = await classifyMisroutedForeignCommit({
        repoDir: dir,
        sha,
        commitSubject: "chore: changeset only",
        commitBody: "Fusion-Task-Id: FN-1234",
        currentTaskId: "FN-8888",
      });

      expect(result.misrouted).toBe(true);
      expect(result.foreignTaskId).toBe("FN-1234");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies subject-only task attribution and normalizes case", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4948-misrouted-subject-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");
      mkdirSync(join(dir, ".changeset"), { recursive: true });
      writeFileSync(join(dir, ".changeset", "fn-7777-feature.md"), "minor\n");
      git(dir, "git add .changeset/fn-7777-feature.md && git commit -m 'feat(fn-7777): add feature' ");
      const sha = git(dir, "git rev-parse HEAD");

      const result = await classifyMisroutedForeignCommit({
        repoDir: dir,
        sha,
        commitSubject: "feat(fn-7777): add feature",
        commitBody: "",
        currentTaskId: "FN-0001",
      });

      expect(result.misrouted).toBe(true);
      expect(result.foreignTaskId).toBe("FN-7777");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not classify misrouted when shared paths are present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4948-misrouted-shared-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      writeFileSync(join(dir, "README.md"), "init\n");
      git(dir, "git add README.md && git commit -m 'init'");
      mkdirSync(join(dir, ".changeset"), { recursive: true });
      mkdirSync(join(dir, "packages", "engine", "src"), { recursive: true });
      writeFileSync(join(dir, ".changeset", "fn-4321-fix.md"), "patch\n");
      writeFileSync(join(dir, "packages", "engine", "src", "executor.ts"), "x\n");
      git(dir, "git add .changeset/fn-4321-fix.md packages/engine/src/executor.ts");
      git(dir, "git commit -m 'fix(FN-4321): mixed paths' -m 'Fusion-Task-Id: FN-4321'");
      const sha = git(dir, "git rev-parse HEAD");

      const result = await classifyMisroutedForeignCommit({
        repoDir: dir,
        sha,
        commitSubject: "fix(FN-4321): mixed paths",
        commitBody: "Fusion-Task-Id: FN-4321",
        currentTaskId: "FN-1111",
      });

      expect(result.misrouted).toBe(false);
      expect(result.foreignTaskId).toBe("FN-4321");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not classify when attribution matches current task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4948-misrouted-same-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");
      mkdirSync(join(dir, ".changeset"), { recursive: true });
      writeFileSync(join(dir, ".changeset", "fn-9000-fix.md"), "patch\n");
      git(dir, "git add .changeset/fn-9000-fix.md && git commit -m 'test(FN-9000): same task' ");
      const sha = git(dir, "git rev-parse HEAD");

      const result = await classifyMisroutedForeignCommit({
        repoDir: dir,
        sha,
        commitSubject: "test(FN-9000): same task",
        commitBody: "",
        currentTaskId: "fn-9000",
      });

      expect(result.misrouted).toBe(false);
      expect(result.foreignTaskId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

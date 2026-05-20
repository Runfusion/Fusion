import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { commitOrAmendMergeWithFixes } from "../merger.js";
import { DEFAULT_SETTINGS } from "@fusion/core";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function initRepo(dir: string): void {
  git(dir, "git init -b main");
  git(dir, 'git config user.email "test@example.com"');
  git(dir, 'git config user.name "Test"');
  git(dir, "git config commit.gpgsign false");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "git add README.md");
  git(dir, 'git commit -m "chore: initial"');
}

function stageSquashThenClear(dir: string, branch: string, file: string, content: string): string {
  git(dir, `git checkout -b ${branch}`);
  writeFileSync(join(dir, file), content);
  git(dir, `git add ${file}`);
  git(dir, `git commit -m "feat: add ${file}"`);
  git(dir, "git checkout main");
  const preAttemptSha = git(dir, "git rev-parse HEAD");
  git(dir, `git merge --squash ${branch}`);
  // Simulate a no-op in-merge fix path where staged squash content gets cleared.
  git(dir, "git reset HEAD -- .");
  return preAttemptSha;
}

function assertIsolatedWorkspace(dir: string): void {
  const repoRoot = process.env.FUSION_TEST_REAL_ROOT;
  if (!repoRoot) return;
  expect(resolve(dir).startsWith(resolve(repoRoot))).toBe(false);
}

const STUB_SETTINGS = {
  ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
  commitAuthorEnabled: false,
};

describe("commitOrAmendMergeWithFixes no-op finalize", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-test-merger-noop-"));
    assertIsolatedWorkspace(dir);
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-squashes and commits when fix run is a no-op but branch content exists", async () => {
    const preAttemptSha = stageSquashThenClear(dir, "feat/noop", "feature-a.ts", "export const a = 1;\n");
    expect(git(dir, "git diff --cached --name-only")).toBe("");
    expect(git(dir, "git rev-parse HEAD")).toBe(preAttemptSha);
    expect(readFileSync(join(dir, "feature-a.ts"), "utf-8")).toBe("export const a = 1;\n");

    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-3773",
      "feat/noop",
      "- feat: add feature-a.ts",
      false,
      preAttemptSha,
      "",
      undefined,
      STUB_SETTINGS,
      undefined,
      null,
      null,
      new Set<string>(),
    );

    expect(result.ok).toBe(true);
    const committedFiles = git(dir, "git diff --name-only HEAD~1 HEAD").split("\n").filter(Boolean);
    expect(committedFiles).toContain("feature-a.ts");
  });

  it("still refuses real phantom finalize when nothing staged and HEAD belongs to another task", async () => {
    // Real phantom case: no current-task squash state and HEAD belongs to another task.
    writeFileSync(join(dir, "outside.txt"), "outside\n");
    git(dir, "git add outside.txt");
    git(dir, 'git commit -m "feat: unrelated commit\n\nFusion-Task-Id: FN-OTHER"');
    const preAttemptSha = git(dir, "git rev-parse HEAD");

    const result = await commitOrAmendMergeWithFixes(
      dir,
      "FN-3773",
      "feat/phantom",
      "- feat: add feature-b.ts",
      false,
      preAttemptSha,
      "",
      undefined,
      STUB_SETTINGS,
      undefined,
      null,
      null,
      new Set<string>(),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown-phantom");
  });
});

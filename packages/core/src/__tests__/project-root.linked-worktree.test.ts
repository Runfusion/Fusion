import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinkedWorktreeBootstrapRefusedError } from "../project-root-guard.js";
import { TaskStore } from "../store.js";

function git(command: string, cwd: string): string {
  return execSync(command, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

describe("linked worktree bootstrap guard", () => {
  const originalVitest = process.env.VITEST;
  const originalOptIn = process.env.FUSION_TEST_LINKED_WORKTREE_GUARD;
  const originalAllowNested = process.env.FUSION_ALLOW_NESTED_PROJECT;
  let tempDir: string;

  beforeEach(() => {
    process.env.VITEST = "true";
    process.env.FUSION_TEST_LINKED_WORKTREE_GUARD = "1";
    delete process.env.FUSION_ALLOW_NESTED_PROJECT;
    tempDir = mkdtempSync(join(tmpdir(), "fn-linked-worktree-guard-"));
  });

  afterEach(() => {
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
    if (originalOptIn === undefined) delete process.env.FUSION_TEST_LINKED_WORKTREE_GUARD;
    else process.env.FUSION_TEST_LINKED_WORKTREE_GUARD = originalOptIn;
    if (originalAllowNested === undefined) delete process.env.FUSION_ALLOW_NESTED_PROJECT;
    else process.env.FUSION_ALLOW_NESTED_PROJECT = originalAllowNested;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setupRepoWithLinkedWorktree(): { repoDir: string; worktreePath: string } {
    const repoDir = join(tempDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    git("git init --initial-branch=main", repoDir);
    git('git config user.name "Fusion Test"', repoDir);
    git('git config user.email "test@example.com"', repoDir);
    writeFileSync(join(repoDir, "README.md"), "root\n");
    git("git add README.md", repoDir);
    git('git commit -m "init"', repoDir);

    const worktreePath = join(tempDir, "repo-worktree");
    git(`git worktree add -b feature/test ${worktreePath}`, repoDir);
    return { repoDir, worktreePath };
  }

  it("refuses TaskStore bootstrap inside a linked worktree when the parent project already exists", () => {
    const { repoDir, worktreePath } = setupRepoWithLinkedWorktree();
    mkdirSync(join(repoDir, ".fusion"), { recursive: true });
    writeFileSync(join(repoDir, ".fusion", "fusion.db"), "");

    expect(() => new TaskStore(worktreePath)).toThrow(LinkedWorktreeBootstrapRefusedError);
    expect(() => new TaskStore(worktreePath)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining(worktreePath),
      }),
    );
    try {
      new TaskStore(worktreePath);
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedWorktreeBootstrapRefusedError);
      expect((error as Error).message).toContain(worktreePath);
      expect((error as Error).message).toContain(repoDir);
      expect((error as Error).message).toContain("FUSION_ALLOW_NESTED_PROJECT=1");
      return;
    }
    throw new Error("Expected linked-worktree bootstrap refusal");
  });

  it("allows bootstrap when the nested-project escape hatch is set", () => {
    const { repoDir, worktreePath } = setupRepoWithLinkedWorktree();
    mkdirSync(join(repoDir, ".fusion"), { recursive: true });
    writeFileSync(join(repoDir, ".fusion", "fusion.db"), "");
    process.env.FUSION_ALLOW_NESTED_PROJECT = "1";

    const store = new TaskStore(worktreePath, dirname(worktreePath), { inMemoryDb: true });
    store.close();
  });

  it("allows bootstrap when the parent repo has no Fusion project", () => {
    const { worktreePath } = setupRepoWithLinkedWorktree();
    const store = new TaskStore(worktreePath, dirname(worktreePath), { inMemoryDb: true });
    store.close();
  });

  it("allows bootstrap outside git repositories", () => {
    const plainDir = join(tempDir, "plain");
    mkdirSync(plainDir, { recursive: true });

    const store = new TaskStore(plainDir, dirname(plainDir), { inMemoryDb: true });
    store.close();
  });

  it("allows bootstrap from the main worktree even when it already has a Fusion project", () => {
    const repoDir = join(tempDir, "repo-main");
    mkdirSync(repoDir, { recursive: true });
    git("git init --initial-branch=main", repoDir);
    mkdirSync(join(repoDir, ".fusion"), { recursive: true });
    writeFileSync(join(repoDir, ".fusion", "fusion.db"), "");

    expect(existsSync(join(repoDir, ".git"))).toBe(true);
    const store = new TaskStore(repoDir, dirname(repoDir), { inMemoryDb: true });
    store.close();
  });
});

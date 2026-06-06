import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ensureGitRepositoryForProjectPath,
  GitRepositoryInitializationError,
  type GitRepositoryCommandRunner,
} from "../git-repository.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 10_000,
    encoding: "utf-8",
  });
  return stdout.trim();
}

describe("ensureGitRepositoryForProjectPath", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
  });

  function tempDir(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(path);
    return path;
  }

  it("initializes an empty directory without creating commits or files", async () => {
    const projectPath = tempDir("fusion-git-init-");

    const outcome = await ensureGitRepositoryForProjectPath(projectPath);

    expect(outcome).toBe("initialized");
    expect(existsSync(join(projectPath, ".git"))).toBe(true);
    await expect(git(projectPath, ["rev-parse", "--is-inside-work-tree"])).resolves.toBe("true");
    await expect(git(projectPath, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
    expect(existsSync(join(projectPath, ".gitkeep"))).toBe(false);
  });

  it("leaves an existing repository commits, config, and remotes unchanged", async () => {
    const projectPath = tempDir("fusion-git-existing-");
    await git(projectPath, ["init"]);
    await git(projectPath, ["config", "user.name", "Existing User"]);
    await git(projectPath, ["config", "user.email", "existing@example.com"]);
    writeFileSync(join(projectPath, "README.md"), "# Existing\n");
    await git(projectPath, ["add", "README.md"]);
    await git(projectPath, ["commit", "-m", "existing commit"]);
    await git(projectPath, ["remote", "add", "origin", "https://github.com/example/repo.git"]);

    const beforeCommitCount = await git(projectPath, ["rev-list", "--count", "HEAD"]);
    const beforeUserName = await git(projectPath, ["config", "user.name"]);
    const beforeRemote = await git(projectPath, ["remote", "get-url", "origin"]);

    const outcome = await ensureGitRepositoryForProjectPath(projectPath);

    expect(outcome).toBe("existing");
    await expect(git(projectPath, ["rev-list", "--count", "HEAD"])).resolves.toBe(beforeCommitCount);
    await expect(git(projectPath, ["config", "user.name"])).resolves.toBe(beforeUserName);
    await expect(git(projectPath, ["remote", "get-url", "origin"])).resolves.toBe(beforeRemote);
  });

  it("treats a linked worktree with .git as a file as an existing repository", async () => {
    const repoPath = tempDir("fusion-git-worktree-repo-");
    const worktreeParent = tempDir("fusion-git-worktree-parent-");
    const worktreePath = join(worktreeParent, "linked");
    await git(repoPath, ["init"]);
    await git(repoPath, ["config", "user.name", "Existing User"]);
    await git(repoPath, ["config", "user.email", "existing@example.com"]);
    writeFileSync(join(repoPath, "README.md"), "# Existing\n");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "existing commit"]);
    await git(repoPath, ["worktree", "add", worktreePath]);

    const outcome = await ensureGitRepositoryForProjectPath(worktreePath);

    expect(outcome).toBe("existing");
    expect(existsSync(join(worktreePath, ".git"))).toBe(true);
    await expect(git(worktreePath, ["rev-parse", "--is-inside-work-tree"])).resolves.toBe("true");
  });

  it("throws an actionable error when git init fails", async () => {
    const projectPath = tempDir("fusion-git-fail-");
    const runner: GitRepositoryCommandRunner = async (_command, args) => {
      if (args.includes("rev-parse")) {
        throw new Error("not a repository");
      }
      throw Object.assign(new Error("spawn git ENOENT"), { stderr: "git is not installed" });
    };

    await expect(
      ensureGitRepositoryForProjectPath(projectPath, { runner }),
    ).rejects.toMatchObject({
      name: "GitRepositoryInitializationError",
      path: projectPath,
      causeMessage: "git is not installed",
    });
    await expect(
      ensureGitRepositoryForProjectPath(projectPath, { runner }),
    ).rejects.toBeInstanceOf(GitRepositoryInitializationError);
  });
});

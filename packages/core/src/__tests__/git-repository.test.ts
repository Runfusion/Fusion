import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ensureGitRepositoryForProjectPath,
  GitRepositoryInitializationError,
  detectWorkspaceRepos,
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

  it("skips git init for a workspace-mode project root (.fusion/workspace.json present)", async () => {
    const projectPath = tempDir("fusion-git-workspace-");
    // Simulate workspace init: .fusion/workspace.json exists, root is non-git
    mkdirSync(join(projectPath, ".fusion"), { recursive: true });
    writeFileSync(join(projectPath, ".fusion", "workspace.json"), JSON.stringify({ repos: ["repo-a"] }));

    const outcome = await ensureGitRepositoryForProjectPath(projectPath);

    expect(outcome).toBe("existing");
    // No .git should be created at the workspace root
    expect(existsSync(join(projectPath, ".git"))).toBe(false);
  });

  it("detects workspace sub-repos and skips git init when workspace.json is missing", async () => {
    const projectPath = tempDir("fusion-git-workspace-detect-");
    // Create a real git sub-repo inside the project root (but no workspace.json)
    const subRepo = join(projectPath, "repo-a");
    mkdirSync(subRepo, { recursive: true });
    await git(subRepo, ["init", "-b", "main"]);
    await git(subRepo, ["config", "user.email", "test@test.com"]);
    await git(subRepo, ["config", "user.name", "Test"]);
    writeFileSync(join(subRepo, "README.md"), "# repo-a\n");
    await git(subRepo, ["add", "README.md"]);
    await git(subRepo, ["commit", "-m", "init"]);

    const outcome = await ensureGitRepositoryForProjectPath(projectPath);

    expect(outcome).toBe("existing");
    expect(existsSync(join(projectPath, ".git"))).toBe(false);
    // workspace.json should be auto-persisted so future calls hit the fast path
    expect(existsSync(join(projectPath, ".fusion", "workspace.json"))).toBe(true);
    // config.json should reflect workspaceMode: true so the dashboard toggle is correct
    const configPath = join(projectPath, ".fusion", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.settings?.workspaceMode).toBe(true);
  });

  it("does not misclassify node_modules git dirs as workspace sub-repos", async () => {
    const projectPath = tempDir("fusion-git-workspace-nodemodules-");
    // Create a node_modules sub-dir with a real .git (simulates a package installed from git)
    const fakePkg = join(projectPath, "node_modules", "some-package");
    mkdirSync(fakePkg, { recursive: true });
    await git(fakePkg, ["init", "-b", "main"]);
    await git(fakePkg, ["config", "user.email", "test@test.com"]);
    await git(fakePkg, ["config", "user.name", "Test"]);
    writeFileSync(join(fakePkg, "index.js"), "module.exports = {};\n");
    await git(fakePkg, ["add", "index.js"]);
    await git(fakePkg, ["commit", "-m", "init"]);

    // Also create a real sibling sub-repo to prove it IS detected while node_modules is excluded
    const realRepo = join(projectPath, "my-app");
    mkdirSync(realRepo, { recursive: true });
    await git(realRepo, ["init", "-b", "main"]);
    await git(realRepo, ["config", "user.email", "test@test.com"]);
    await git(realRepo, ["config", "user.name", "Test"]);
    writeFileSync(join(realRepo, "README.md"), "# my-app\n");
    await git(realRepo, ["add", "README.md"]);
    await git(realRepo, ["commit", "-m", "init"]);

    const detected = await detectWorkspaceRepos(projectPath);

    // node_modules is excluded; my-app is detected
    expect(detected).toEqual(["my-app"]);
  });

  it("skips auto-detection when workspaceMode is explicitly false in config.json", async () => {
    const projectPath = tempDir("fusion-git-workspace-disabled-");
    // Create a real git sub-repo so detectWorkspaceRepos would find it
    const subRepo = join(projectPath, "repo-a");
    mkdirSync(subRepo, { recursive: true });
    await git(subRepo, ["init", "-b", "main"]);
    await git(subRepo, ["config", "user.email", "test@test.com"]);
    await git(subRepo, ["config", "user.name", "Test"]);
    writeFileSync(join(subRepo, "README.md"), "# repo-a\n");
    await git(subRepo, ["add", "README.md"]);
    await git(subRepo, ["commit", "-m", "init"]);

    // Write config.json with workspaceMode: false (user disabled it via dashboard)
    mkdirSync(join(projectPath, ".fusion"), { recursive: true });
    writeFileSync(
      join(projectPath, ".fusion", "config.json"),
      JSON.stringify({ settings: { workspaceMode: false } }),
    );

    const outcome = await ensureGitRepositoryForProjectPath(projectPath);

    // Should proceed to git init, not workspace detection
    expect(outcome).toBe("initialized");
    expect(existsSync(join(projectPath, ".git"))).toBe(true);
  });
});

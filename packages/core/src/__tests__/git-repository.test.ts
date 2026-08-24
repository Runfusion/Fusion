import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ensureGitRepositoryForProjectPath,
  GitRepositoryInitializationError,
  detectWorkspaceRepos,
  type GitRepositoryCommandRunner,
} from "../git/git-repository.js";

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

  it("initializes an empty directory with a real baseline and task worktree support", async () => {
    const projectPath = tempDir("fusion-git-init-");
    const worktreePath = join(tempDir("fusion-git-worktree-") , "task");

    const outcome = await ensureGitRepositoryForProjectPath(projectPath);

    expect(outcome).toBe("initialized");
    expect(existsSync(join(projectPath, ".git"))).toBe(true);
    await expect(git(projectPath, ["rev-parse", "--is-inside-work-tree"])).resolves.toBe("true");
    await expect(git(projectPath, ["rev-parse", "--verify", "HEAD^{commit}"])).resolves.toMatch(/^[0-9a-f]+$/);
    expect(await git(projectPath, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe(".gitignore");
    expect(readFileSync(join(projectPath, ".gitignore"), "utf8")).toBe(
      ".fusion/\n.pi/\n.worktrees/\nfusion.db\nfusion.db-wal\nfusion.db-shm\n",
    );
    await git(projectPath, ["worktree", "add", "-b", "fusion/fn-038", worktreePath, "HEAD"]);
    expect(existsSync(join(worktreePath, ".gitignore"))).toBe(true);
    await git(projectPath, ["worktree", "remove", "--force", worktreePath]);
  });

  it("does not commit application files when preparing a populated non-Git directory", async () => {
    const projectPath = tempDir("fusion-git-populated-");
    writeFileSync(join(projectPath, "README.md"), "user content\n");
    writeFileSync(join(projectPath, ".gitignore"), "dist/\r\n\r\n");

    await ensureGitRepositoryForProjectPath(projectPath);

    expect(await git(projectPath, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe(".gitignore");
    expect(readFileSync(join(projectPath, ".gitignore"), "utf8")).toBe(
      "dist/\r\n\r\n.fusion/\r\n.pi/\r\n.worktrees/\r\nfusion.db\r\nfusion.db-wal\r\nfusion.db-shm\r\n",
    );
    expect(existsSync(join(projectPath, "README.md"))).toBe(true);
    const status = await git(projectPath, ["status", "--porcelain"]);
    expect(status).toContain("README.md");
    /*
    FNXC:ProjectSetup 2026-08-19-13:25:
    The baseline contains only managed rules; the user's pre-existing ignore rule must
    remain an unstaged, operator-visible edit instead of being silently staged by setup.
    */
    await expect(git(projectPath, ["diff", "--", ".gitignore"])).resolves.toContain("dist/");
    await expect(git(projectPath, ["diff", "--cached", "--", ".gitignore"])).resolves.toBe("");
    for (const artifact of [".fusion", ".pi", ".worktrees", "fusion.db", "fusion.db-wal", "fusion.db-shm"]) {
      if (artifact.startsWith(".")) mkdirSync(join(projectPath, artifact), { recursive: true });
      else writeFileSync(join(projectPath, artifact), "state\n");
      await expect(git(projectPath, ["check-ignore", "-q", artifact])).resolves.toBe("");
    }
  });

  it("prepares an unborn repository without renaming its branch or committing staged user files", async () => {
    const projectPath = tempDir("fusion-git-unborn-");
    await git(projectPath, ["init"]);
    await git(projectPath, ["symbolic-ref", "HEAD", "refs/heads/operator-branch"]);
    writeFileSync(join(projectPath, "app.txt"), "staged by user\n");
    await git(projectPath, ["add", "app.txt"]);

    await ensureGitRepositoryForProjectPath(projectPath);

    await expect(git(projectPath, ["symbolic-ref", "--short", "HEAD"])).resolves.toBe("operator-branch");
    expect(await git(projectPath, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe(".gitignore");
    expect(await git(projectPath, ["status", "--porcelain"])).toContain("A  app.txt");
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

    writeFileSync(join(projectPath, ".gitignore"), "dist/\n");
    const beforeCommit = await git(projectPath, ["rev-parse", "HEAD"]);
    const beforeCommitCount = await git(projectPath, ["rev-list", "--count", "HEAD"]);
    const beforeUserName = await git(projectPath, ["config", "user.name"]);
    const beforeRemote = await git(projectPath, ["remote", "get-url", "origin"]);
    writeFileSync(join(projectPath, "staged.txt"), "staged\n");
    await git(projectPath, ["add", "staged.txt"]);

    const outcome = await ensureGitRepositoryForProjectPath(projectPath);
    const firstIgnore = readFileSync(join(projectPath, ".gitignore"), "utf8");
    const firstCommit = await git(projectPath, ["rev-parse", "HEAD"]);
    await ensureGitRepositoryForProjectPath(projectPath);

    expect(outcome).toBe("existing");
    expect(firstCommit).toBe(beforeCommit);
    await expect(git(projectPath, ["rev-parse", "HEAD"])).resolves.toBe(beforeCommit);
    await expect(git(projectPath, ["rev-list", "--count", "HEAD"])).resolves.toBe(beforeCommitCount);
    await expect(git(projectPath, ["config", "user.name"])).resolves.toBe(beforeUserName);
    await expect(git(projectPath, ["remote", "get-url", "origin"])).resolves.toBe(beforeRemote);
    expect(readFileSync(join(projectPath, ".gitignore"), "utf8")).toBe(firstIgnore);
    expect(await git(projectPath, ["status", "--porcelain"])).toContain("A  staged.txt");
    for (const rule of [".fusion/", ".pi/", ".worktrees/", "fusion.db", "fusion.db-wal", "fusion.db-shm"]) {
      expect(firstIgnore).toContain(rule);
    }
  });

  it("merges equivalent managed rules without duplicates and converges concurrent calls", async () => {
    const projectPath = tempDir("fusion-git-equivalent-rules-");
    writeFileSync(join(projectPath, ".gitignore"), "/.fusion/\n.pi\n/worktrees/\nfusion.db\n");

    const outcomes = await Promise.all([
      ensureGitRepositoryForProjectPath(projectPath),
      ensureGitRepositoryForProjectPath(projectPath),
    ]);

    expect(outcomes.sort()).toEqual(["existing", "initialized"]);
    const content = readFileSync(join(projectPath, ".gitignore"), "utf8");
    expect(content.match(/fusion\.db(?:\r?\n|$)/g)).toHaveLength(1);
    expect(content.match(/\.fusion\/?(?:\r?\n|$)/g)).toHaveLength(1);
    expect(content).toContain(".worktrees/");
    await expect(git(projectPath, ["rev-list", "--count", "HEAD"])).resolves.toBe("1");
  });

  it.skipIf(process.platform === "win32")("supports special-character paths and refuses an unsafe .gitignore symlink", async () => {
    const projectPath = tempDir("fusion git [special]-");
    await ensureGitRepositoryForProjectPath(projectPath);
    await expect(git(projectPath, ["rev-parse", "--verify", "HEAD^{commit}"])).resolves.toMatch(/^[0-9a-f]+$/);

    const symlinkPath = tempDir("fusion-git-symlink-target-");
    const symlinkProject = tempDir("fusion-git-symlink-");
    symlinkSync(join(symlinkPath, "outside-ignore"), join(symlinkProject, ".gitignore"));
    await expect(ensureGitRepositoryForProjectPath(symlinkProject)).rejects.toMatchObject({
      name: "GitRepositoryInitializationError",
      causeMessage: expect.stringMatching(/symbolic link/i),
    });
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

  it("keeps a configured workspace root non-Git while preparing every member", async () => {
    const projectPath = tempDir("fusion-git-workspace-");
    const firstRepo = join(projectPath, "repo-a");
    const secondRepo = join(projectPath, "repo-b");
    mkdirSync(firstRepo, { recursive: true });
    mkdirSync(secondRepo, { recursive: true });
    writeFileSync(join(firstRepo, "README.md"), "repo a\n");
    await git(secondRepo, ["init"]);
    await git(secondRepo, ["config", "user.name", "Repo User"]);
    await git(secondRepo, ["config", "user.email", "repo@example.com"]);
    writeFileSync(join(secondRepo, "README.md"), "repo b\n");
    await git(secondRepo, ["add", "README.md"]);
    await git(secondRepo, ["commit", "-m", "repo b"]);
    mkdirSync(join(projectPath, ".fusion"), { recursive: true });
    writeFileSync(join(projectPath, ".fusion", "workspace.json"), JSON.stringify({ repos: ["repo-a", "repo-b"] }));

    const outcome = await ensureGitRepositoryForProjectPath(projectPath);

    expect(outcome).toBe("initialized");
    expect(existsSync(join(projectPath, ".git"))).toBe(false);
    await expect(git(firstRepo, ["rev-parse", "HEAD^{commit}"])).resolves.toMatch(/^[0-9a-f]+$/);
    await expect(git(secondRepo, ["rev-list", "--count", "HEAD"])).resolves.toBe("1");
    expect(readFileSync(join(firstRepo, ".gitignore"), "utf8")).toContain(".worktrees/");
    expect(readFileSync(join(secondRepo, ".gitignore"), "utf8")).toContain(".worktrees/");
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

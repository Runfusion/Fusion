import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { relocateReclaimableWorktreeIntoRoot } from "../worktree/worktree-pool.js";

const cleanupPaths: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createRepositoryFixture(): { rootDir: string; sourcePath: string; targetPath: string } {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "fn-8400-reclaim-placement-"));
  cleanupPaths.push(fixtureRoot);
  const rootDir = join(fixtureRoot, "repo");
  const sourcePath = join(fixtureRoot, "legacy-worktrees", "recover-fn-8400");
  const targetPath = join(rootDir, ".worktrees", "recover-fn-8400");

  git(fixtureRoot, ["init", "repo"]);
  git(rootDir, ["config", "user.name", "Fusion Test"]);
  git(rootDir, ["config", "user.email", "fusion-test@example.com"]);
  writeFileSync(join(rootDir, "README.md"), "base\n");
  git(rootDir, ["add", "README.md"]);
  git(rootDir, ["commit", "-m", "base"]);
  git(rootDir, ["worktree", "add", "-b", "fusion/fn-8400", sourcePath, "HEAD"]);
  writeFileSync(join(sourcePath, "preserved.txt"), "uncommitted task work\n");

  return { rootDir, sourcePath, targetPath };
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

describe("reclaimable worktree placement", () => {
  it("moves a registered legacy worktree into the configured root without losing task work", async () => {
    const { rootDir, sourcePath, targetPath } = createRepositoryFixture();

    const result = await relocateReclaimableWorktreeIntoRoot({
      rootDir,
      sourcePath,
      targetPath,
      taskId: "FN-8400",
      settings: {},
      isPathActive: async () => false,
    });

    expect(result).toEqual({ kind: "ready", path: targetPath, relocated: true });
    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(join(targetPath, "preserved.txt"), "utf8")).toBe("uncommitted task work\n");
    expect(git(rootDir, ["worktree", "list", "--porcelain"])).toContain(`worktree ${realpathSync(targetPath)}`);
    expect(git(targetPath, ["branch", "--show-current"])).toBe("fusion/fn-8400");
    expect(git(targetPath, ["status", "--porcelain"])).toContain("?? preserved.txt");
  });

  it("defers without moving when the exact legacy path is still active", async () => {
    const { rootDir, sourcePath, targetPath } = createRepositoryFixture();

    const result = await relocateReclaimableWorktreeIntoRoot({
      rootDir,
      sourcePath,
      targetPath,
      taskId: "FN-8400",
      settings: {},
      isPathActive: async (path) => path === sourcePath,
    });

    expect(result).toEqual({ kind: "deferred-live", path: sourcePath });
    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(targetPath)).toBe(false);
    expect(git(rootDir, ["worktree", "list", "--porcelain"])).toContain(`worktree ${realpathSync(sourcePath)}`);
  });

  it("preserves the backend-assigned path when Worktrunk owns the layout", async () => {
    const { rootDir, sourcePath, targetPath } = createRepositoryFixture();

    const result = await relocateReclaimableWorktreeIntoRoot({
      rootDir,
      sourcePath,
      targetPath,
      taskId: "FN-8400",
      settings: { worktrunk: { enabled: true } },
      isPathActive: async () => false,
    });

    expect(result).toEqual({ kind: "ready", path: sourcePath, relocated: false });
    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(targetPath)).toBe(false);
    expect(git(rootDir, ["worktree", "list", "--porcelain"])).toContain(`worktree ${realpathSync(sourcePath)}`);
  });

  it("chooses a task-scoped target when the legacy basename is occupied", async () => {
    const { rootDir, sourcePath, targetPath } = createRepositoryFixture();
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(join(targetPath, "owner.txt"), "unrelated path\n");
    const disambiguatedPath = `${targetPath}-fn-8400`;

    const result = await relocateReclaimableWorktreeIntoRoot({
      rootDir,
      sourcePath,
      targetPath,
      taskId: "FN-8400",
      settings: { worktreeNaming: "random" },
      isPathActive: async () => false,
    });

    expect(result).toEqual({ kind: "ready", path: disambiguatedPath, relocated: true });
    expect(readFileSync(join(targetPath, "owner.txt"), "utf8")).toBe("unrelated path\n");
    expect(readFileSync(join(disambiguatedPath, "preserved.txt"), "utf8")).toBe("uncommitted task work\n");
    expect(git(rootDir, ["worktree", "list", "--porcelain"])).toContain(`worktree ${realpathSync(disambiguatedPath)}`);
  });

  it("rejects a relocation target outside the configured root before touching the source", async () => {
    const { rootDir, sourcePath } = createRepositoryFixture();
    const invalidTarget = join(dirname(rootDir), "still-outside", "recover-fn-8400");

    await expect(relocateReclaimableWorktreeIntoRoot({
      rootDir,
      sourcePath,
      targetPath: invalidTarget,
      taskId: "FN-8400",
      settings: {},
      isPathActive: async () => false,
    })).rejects.toThrow(/outside configured worktrees directory/);

    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(invalidTarget)).toBe(false);
  });
});

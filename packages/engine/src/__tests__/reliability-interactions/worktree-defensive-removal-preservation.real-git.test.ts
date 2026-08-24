import { access, constants as fsConstants, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RemovalReason,
  removeWorktree,
} from "../../worktree/worktree-backend.js";
import { reapOrphanWorktrees } from "../../worktree/worktree-pool.js";
import { git, hasGit } from "./_helpers.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasGit)("reliability interactions: defensive removal preserves unverifiable content", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function setupRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "fusion-defensive-remove-"));
    roots.push(root);
    git(root, "git init -b main");
    git(root, 'git config user.email "test@example.com"');
    git(root, 'git config user.name "Test User"');
    await writeFile(join(root, "README.md"), "# repo\n", "utf-8");
    await writeFile(join(root, ".gitignore"), "dist/\n", "utf-8");
    git(root, "git add README.md .gitignore");
    git(root, 'git commit -m "init"');
    await mkdir(join(root, ".worktrees"), { recursive: true });
    return root;
  }

  async function createWorktree(root: string, name: string): Promise<string> {
    const worktreePath = join(root, ".worktrees", name);
    git(root, `git worktree add -b ${JSON.stringify(`fusion/${name}`)} ${JSON.stringify(worktreePath)}`);
    return worktreePath;
  }

  it("pool-prune refuses and preserves a dirty registered worktree", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "dirty-prune");
    await writeFile(join(worktreePath, "wip.txt"), "uncommitted\n", "utf-8");

    await expect(
      removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.PoolPrune }),
    ).rejects.toThrow(/preserving/);

    expect(await readFile(join(worktreePath, "wip.txt"), "utf-8")).toBe("uncommitted\n");
  });

  it("idle-sweep refuses and preserves a dirty registered worktree", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "dirty-idle");
    await writeFile(join(worktreePath, "wip.txt"), "uncommitted\n", "utf-8");

    await expect(
      removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.SelfHealingIdleSweep }),
    ).rejects.toThrow(/preserving/);

    expect(await pathExists(worktreePath)).toBe(true);
  });

  it("pool-prune preserves user content under an ignored generated-looking path", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "ignored-prune");
    await mkdir(join(worktreePath, "dist"), { recursive: true });
    await writeFile(join(worktreePath, "dist", "manual.txt"), "precious\n", "utf-8");

    await expect(
      removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.PoolPrune }),
    ).rejects.toThrow(/preserving/);

    expect(await readFile(join(worktreePath, "dist", "manual.txt"), "utf-8")).toBe("precious\n");
  });

  it.each([
    RemovalReason.MergerCleanup,
    RemovalReason.MergerPostMerge,
    RemovalReason.SelfHealingBranchConflict,
    RemovalReason.SelfHealingReclaim,
    RemovalReason.SelfHealingStaleActiveBranch,
    RemovalReason.StepSessionCleanup,
  ])("%s preserves a dirty automatically managed worktree", async (reason) => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, reason);
    await writeFile(join(worktreePath, "wip.txt"), "uncommitted\n", "utf-8");

    await expect(removeWorktree({ rootDir: root, worktreePath, settings: {}, reason })).rejects.toThrow(/preserving/);

    expect(await readFile(join(worktreePath, "wip.txt"), "utf-8")).toBe("uncommitted\n");
  });

  it("a failing status probe preserves the checkout instead of enabling deletion", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "corrupt-probe");
    // Corrupt the registration so the cleanliness probe cannot run at all.
    await rm(join(root, ".git", "worktrees", "corrupt-probe"), { recursive: true, force: true });

    await expect(
      removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.PoolPrune }),
    ).rejects.toThrow(/preserving/);

    expect(await pathExists(join(worktreePath, "README.md"))).toBe(true);
  });

  it("clean registered worktrees are still removed by pool-prune", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "clean-prune");

    await removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.PoolPrune });

    expect(await pathExists(worktreePath)).toBe(false);
  });

  it("addressed teardown reasons keep their legacy forced semantics on dirty worktrees", async () => {
    const root = await setupRepo();
    const worktreePath = await createWorktree(root, "task-reset-dirty");
    await writeFile(join(worktreePath, "wip.txt"), "uncommitted\n", "utf-8");

    await removeWorktree({ rootDir: root, worktreePath, settings: {}, reason: RemovalReason.TaskReset });

    expect(await pathExists(worktreePath)).toBe(false);
  });

  it("startup reaper preserves dangling or content orphans", async () => {
    const root = await setupRepo();

    const danglingOrphan = join(root, ".worktrees", "dangling-orphan");
    await mkdir(danglingOrphan, { recursive: true });
    await writeFile(join(danglingOrphan, ".git"), "gitdir: /nonexistent/admin\n", "utf-8");

    const contentOrphan = join(root, ".worktrees", "content-orphan");
    await mkdir(contentOrphan, { recursive: true });
    await writeFile(join(contentOrphan, ".git"), "gitdir: /nonexistent/admin\n", "utf-8");
    await writeFile(join(contentOrphan, "wip.txt"), "precious\n", "utf-8");

    await reapOrphanWorktrees(root);

    expect(await pathExists(join(danglingOrphan, ".git"))).toBe(true);
    expect(await readFile(join(contentOrphan, "wip.txt"), "utf-8")).toBe("precious\n");
    expect(dirname(contentOrphan)).toBe(join(root, ".worktrees"));
  });
});

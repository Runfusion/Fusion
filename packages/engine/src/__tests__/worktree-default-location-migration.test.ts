import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupOrphanedWorktrees, scanIdleWorktrees } from "../worktree/worktree-pool.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-worktree-location-migration-"));
  fixtureRoots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

function addWorktree(root: string, path: string, branch: string): void {
  execFileSync("git", ["worktree", "add", "-b", branch, path], { cwd: root });
}

const emptyStore = { listTasks: async () => [] } as any;

describe("default worktree location migration", () => {
  it("finds and removes idle worktrees from both roots, then retires an empty legacy root", async () => {
    const root = createRepository();
    const primary = join(root, ".fusion", "worktrees", "fn-primary");
    const legacy = join(root, ".worktrees", "fn-legacy");
    addWorktree(root, primary, "fusion/fn-primary");
    addWorktree(root, legacy, "fusion/fn-legacy");

    /*
    FNXC:WorktreePathTests 2026-08-30-20:16:
    Real Git worktree paths are compared with Node's native realpath result so this regression remains independent of Fusion's canonicalization implementation.
    */
    await expect(scanIdleWorktrees(root, emptyStore)).resolves.toEqual(
      expect.arrayContaining([realpathSync.native(primary), realpathSync.native(legacy)]),
    );
    await expect(cleanupOrphanedWorktrees(root, emptyStore)).resolves.toBe(2);

    expect(existsSync(primary)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(root, ".worktrees"))).toBe(false);
  });

  it("does not scan or retire the legacy root when worktreesDir is configured", async () => {
    const root = createRepository();
    const legacy = join(root, ".worktrees", "fn-legacy");
    addWorktree(root, legacy, "fusion/fn-legacy");
    const settings = { worktreesDir: ".fusion/custom-worktrees" } as any;

    await expect(scanIdleWorktrees(root, emptyStore, settings)).resolves.toEqual([]);
    await expect(cleanupOrphanedWorktrees(root, emptyStore, settings)).resolves.toBe(0);

    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(root, ".worktrees"))).toBe(true);
  });
});

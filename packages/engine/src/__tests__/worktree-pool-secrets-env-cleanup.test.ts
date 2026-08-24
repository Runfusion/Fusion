import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanupSecretsEnvFile = vi.fn();

vi.mock("../worktree/secrets-env-writer.js", () => ({
  cleanupSecretsEnvFile,
}));

const dirs: string[] = [];

/*
FNXC:WorktreeReap 2026-08-23-21:10:
FN-9162 (3b0a6b795f) narrowed orphan reaping to directories that actually LOOK like a linked
worktree, so that a shared/custom worktree root's own container folders can never be swept. A bare
directory is therefore no longer a reap candidate; a leaked worktree is one whose `.git` pointer
still names an admin entry under the main checkout that has since been pruned (dangling). Seed that
shape so these cases exercise the secrets-cleanup hook rather than the classifier.
*/
function seedOrphanWorktree(orphanDir: string): void {
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(join(orphanDir, ".git"), `gitdir: ../../.git/worktrees/${orphanDir.split(/[\\/]/).pop()}\n`);
}

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pool-cleanup-"));
  dirs.push(root);
  return root;
}

afterEach(async () => {
  cleanupSecretsEnvFile.mockReset().mockResolvedValue({ outcome: "cleaned", reason: "fingerprint-match" });
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("worktree-pool secrets cleanup hooks", () => {
  it("reapOrphanWorktrees invokes cleanup before removal", async () => {
    cleanupSecretsEnvFile.mockResolvedValue({ outcome: "cleaned", reason: "fingerprint-match" });
    const root = tmpRoot();
    const worktrees = join(root, ".worktrees");
    const orphan = join(worktrees, "orphan-1");
    seedOrphanWorktree(orphan);
    writeFileSync(join(orphan, ".env"), "A=1\n");

    const mod = await import("../worktree/worktree-pool.js");
    const removed = await mod.reapOrphanWorktrees(root);

    expect(removed).toBe(1);
    expect(cleanupSecretsEnvFile).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: orphan,
      taskId: "orphan:orphan-1",
    }));
    expect(existsSync(orphan)).toBe(false);
  });

  it("cleanup failures do not block orphan removal", async () => {
    cleanupSecretsEnvFile.mockRejectedValueOnce(new Error("cleanup failed"));
    const root = tmpRoot();
    const orphan = join(root, ".worktrees", "orphan-2");
    seedOrphanWorktree(orphan);

    const mod = await import("../worktree/worktree-pool.js");
    const removed = await mod.reapOrphanWorktrees(root);

    expect(removed).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });
});

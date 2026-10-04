import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanupSecretsEnvFile = vi.fn();

vi.mock("../worktree/secrets-env-writer.js", () => ({
  FINGERPRINT_FILE: ".fusion-secrets-env.fingerprint",
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

describe("worktree-pool secrets preservation", () => {
  it("preserves a default .env dangling orphan when a custom filename is configured", async () => {
    cleanupSecretsEnvFile.mockResolvedValue({ outcome: "cleaned", reason: "fingerprint-match" });
    const root = tmpRoot();
    const worktrees = join(root, ".worktrees");
    const orphan = join(worktrees, "orphan-default-env");
    execFileSync("git", ["init", "-q"], { cwd: root });
    seedOrphanWorktree(orphan);
    writeFileSync(join(orphan, ".env"), "A=1\n");

    const mod = await import("../worktree/worktree-pool.js");
    const removed = await mod.reapOrphanWorktrees(root, {
      worktreesDir: ".worktrees",
      secretsEnv: { filename: ".runtime-secrets" },
    });

    expect(removed).toBe(0);
    expect(cleanupSecretsEnvFile).not.toHaveBeenCalled();
    expect(existsSync(orphan)).toBe(true);
  });

  it("preserves a configured secret env filename before any cleanup hook runs", async () => {
    cleanupSecretsEnvFile.mockRejectedValueOnce(new Error("cleanup failed"));
    const root = tmpRoot();
    const worktrees = join(root, ".worktrees");
    const orphan = join(worktrees, "orphan-2");
    execFileSync("git", ["init", "-q"], { cwd: root });
    seedOrphanWorktree(orphan);
    writeFileSync(join(orphan, ".runtime-secrets"), "A=1\n");

    const mod = await import("../worktree/worktree-pool.js");
    const removed = await mod.reapOrphanWorktrees(root, {
      worktreesDir: ".worktrees",
      secretsEnv: { filename: ".runtime-secrets" },
    });

    expect(removed).toBe(0);
    expect(cleanupSecretsEnvFile).not.toHaveBeenCalled();
    expect(existsSync(orphan)).toBe(true);
  });

  it("preserves a fingerprint-bearing dangling orphan before any cleanup hook runs", async () => {
    const root = tmpRoot();
    const worktrees = join(root, ".worktrees");
    const orphan = join(worktrees, "orphan-fingerprint");
    execFileSync("git", ["init", "-q"], { cwd: root });
    seedOrphanWorktree(orphan);
    writeFileSync(join(orphan, ".fusion-secrets-env.fingerprint"), "sha256\n.env\n");

    const mod = await import("../worktree/worktree-pool.js");
    const removed = await mod.reapOrphanWorktrees(root, {
      worktreesDir: ".worktrees",
      secretsEnv: { filename: ".runtime-secrets" },
    });

    expect(removed).toBe(0);
    expect(cleanupSecretsEnvFile).not.toHaveBeenCalled();
    expect(existsSync(orphan)).toBe(true);
  });
});

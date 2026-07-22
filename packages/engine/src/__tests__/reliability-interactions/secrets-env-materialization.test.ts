import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSecretsEnvFile } from "../../worktree/secrets-env-writer.js";
import { reapOrphanWorktrees } from "../../worktree/worktree-pool.js";

const dirs: string[] = [];
function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "secrets-rel-"));
  dirs.push(root);
  execFileSync("git", ["init"], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("reliability interactions: secrets env materialization", () => {
  it("writer refuses non-ignored env path", async () => {
    const root = tmpRepo();
    const worktree = join(root, ".worktrees", "a");
    mkdirSync(worktree, { recursive: true });
    execFileSync("git", ["init"], { cwd: worktree });

    const audit = { filesystem: vi.fn() };
    const result = await writeSecretsEnvFile({
      rootDir: root,
      worktreePath: worktree,
      taskId: "FN-1",
      settings: { secretsEnv: { enabled: true, filename: ".env", requireGitignored: true } },
      worktreeSource: "fresh",
      audit,
      secretsStore: { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any,
    });

    expect(result.reason).toBe("not-gitignored");
    expect(audit.filesystem).toHaveBeenCalledWith(expect.objectContaining({ type: "secret:env-write-skipped" }));
  });

  it("orphan reap reclaims orphaned env artifacts", async () => {
    const root = tmpRepo();
    const worktreesDir = join(root, ".worktrees");
    const orphan = join(worktreesDir, "ghost");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, ".env"), "A=1\n");
    writeFileSync(join(orphan, ".fusion-secrets-env.fingerprint"), "abc\n.env\n");

    const removed = await reapOrphanWorktrees(root);
    expect(removed).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });
});

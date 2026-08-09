import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSecretsEnvFile } from "../../worktree/secrets-env-writer.js";
import { refreshReusedWorktreeBase } from "../../worktree-base-refresh.js";
import { reapOrphanWorktrees } from "../../worktree/worktree-pool.js";
import { acquireTaskWorktree } from "../../worktree/worktree-acquisition.js";

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

  it("adopts a planning-era legacy sidecar before linked-worktree refresh while real dirt still blocks", async () => {
    const root = tmpRepo();
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), ".secrets.env\n");
    writeFileSync(join(root, "README.md"), "base\n");
    execFileSync("git", ["add", ".gitignore", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const worktree = join(root, "linked");
    execFileSync("git", ["worktree", "add", "-b", "fusion/fn-1", worktree, base], { cwd: root });
    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
    await writeSecretsEnvFile({ rootDir: root, worktreePath: worktree, taskId: "FN-1", settings: { secretsEnv: { enabled: true, filename: ".secrets.env" } }, worktreeSource: "fresh", secretsStore });
    const gitDirOutput = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: worktree, encoding: "utf8" }).trim();
    const privateRecord = join(resolve(worktree, gitDirOutput), ".fusion-secrets-env.fingerprint");
    const legacyBytes = `${createHash("sha256").update(readFileSync(join(worktree, ".secrets.env"), "utf8")).digest("hex")}\n.secrets.env\n`;
    // FNXC:SecretsEnvMaterialization 2026-08-08-03:02: This is the byte-for-byte v0.75.1 root wire format left by planning before execution reuses its linked worktree.
    writeFileSync(join(worktree, ".fusion-secrets-env.fingerprint"), legacyBytes);
    rmSync(privateRecord);

    // FNXC:SecretsEnvMaterialization 2026-08-08-03:51: Exercise the production resume seam, not the reconciler in isolation: planning's v0.75.1 root record must be adopted before executor-style refresh evaluates porcelain.
    const store = { updateTask: vi.fn().mockResolvedValue(undefined), logEntry: vi.fn().mockResolvedValue(undefined) } as any;
    await expect(acquireTaskWorktree({
      task: { id: "FN-1", title: "secrets handoff", description: "", branch: "fusion/fn-1", worktree, baseCommitSha: base } as any,
      rootDir: root,
      store,
      settings: { secretsEnv: { enabled: true, filename: ".secrets.env" } } as any,
      refreshStaleBase: true,
      createWorktree: vi.fn(),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    })).resolves.toMatchObject({ source: "existing", isResume: true, baseRefresh: { executionSafe: true } });
    expect(existsSync(join(worktree, ".fusion-secrets-env.fingerprint"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" })).toBe("");

    writeFileSync(join(worktree, "unrelated.txt"), "dirt\n");
    await expect(refreshReusedWorktreeBase({ task: { id: "FN-1", baseCommitSha: base } as any, rootDir: root, worktreePath: worktree, store, settings: {} })).resolves.toMatchObject({ kind: "dirty-worktree", executionSafe: false });
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

import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanupSecretsEnvFile, writeSecretsEnvFile } from "../worktree/secrets-env-writer.js";

const dirs: string[] = [];

function tmpWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "secrets-env-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("secrets-env-writer", () => {
  it("skips silently when disabled", async () => {
    const filesystem = vi.fn();
    const result = await writeSecretsEnvFile({
      rootDir: process.cwd(),
      worktreePath: tmpWorktree(),
      taskId: "FN-1",
      settings: { secretsEnv: { enabled: false } },
      worktreeSource: "fresh",
      audit: { filesystem },
    });
    expect(result).toEqual({ outcome: "skipped", filename: ".env", reason: "disabled" });
    expect(filesystem).not.toHaveBeenCalled();
  });

  it("skips when no store", async () => {
    const filesystem = vi.fn();
    const result = await writeSecretsEnvFile({
      rootDir: process.cwd(),
      worktreePath: tmpWorktree(),
      taskId: "FN-1",
      settings: { secretsEnv: { enabled: true } },
      worktreeSource: "fresh",
      audit: { filesystem },
      execFileImpl: ((_f: string, _a: string[], _o: any, cb: any) => cb(null)) as any,
    });
    expect(result.reason).toBe("no-store");
    expect(filesystem).toHaveBeenCalledWith(expect.objectContaining({ type: "secret:env-write-skipped" }));
  });

  it("writes managed env and sidecar without plaintext in audit/logs", async () => {
    const dir = tmpWorktree();
    const filesystem = vi.fn();
    const log = vi.fn();
    const warn = vi.fn();
    const secretValue = "SUPER_SECRET_VALUE";

    const result = await writeSecretsEnvFile({
      rootDir: process.cwd(),
      worktreePath: dir,
      taskId: "FN-1",
      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
      worktreeSource: "fresh",
      audit: { filesystem },
      logger: { log, warn },
      secretsStore: {
        listEnvExportable: vi.fn().mockResolvedValue([
          { id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: secretValue },
          { id: "2", key: "B", exportKey: "BETA", scope: "global", plaintextValue: "x" },
        ]),
      } as any,
    });

    expect(result.outcome).toBe("written");
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("ALPHA=");
    expect(env).toContain("BETA=");
    const sidecar = readFileSync(join(dir, ".fusion-secrets-env.fingerprint"), "utf8");
    expect(sidecar).toContain(".env");
    if (process.platform !== "win32") {
      expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, ".fusion-secrets-env.fingerprint")).mode & 0o777).toBe(0o600);
    }

    const outputBlob = JSON.stringify({ calls: filesystem.mock.calls, logs: log.mock.calls, warns: warn.mock.calls });
    expect(outputBlob).not.toContain(secretValue);
  });

  it("merge is idempotent", async () => {
    const dir = tmpWorktree();
    writeFileSync(join(dir, ".env"), "EXISTING=1\n");
    const secretsStore = {
      listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]),
    } as any;

    await writeSecretsEnvFile({
      rootDir: process.cwd(),
      worktreePath: dir,
      taskId: "FN-1",
      settings: { secretsEnv: { enabled: true, requireGitignored: false, overwritePolicy: "merge" } },
      worktreeSource: "fresh",
      secretsStore,
    });
    const once = readFileSync(join(dir, ".env"), "utf8");

    await writeSecretsEnvFile({
      rootDir: process.cwd(),
      worktreePath: dir,
      taskId: "FN-1",
      settings: { secretsEnv: { enabled: true, requireGitignored: false, overwritePolicy: "merge" } },
      worktreeSource: "fresh",
      secretsStore,
    });
    const twice = readFileSync(join(dir, ".env"), "utf8");
    expect(twice).toBe(once);
  });

  it("rejects invalid filename and symlink", async () => {
    const dir = tmpWorktree();
    const filesystem = vi.fn();
    const a = await writeSecretsEnvFile({
      rootDir: process.cwd(),
      worktreePath: dir,
      taskId: "FN-1",
      settings: { secretsEnv: { enabled: true, filename: "../x" } },
      worktreeSource: "fresh",
      audit: { filesystem },
      secretsStore: { listEnvExportable: vi.fn() } as any,
    });
    expect(a.reason).toBe("invalid-filename");

    writeFileSync(join(dir, "real.env"), "SAFE=1\n");
    symlinkSync(join(dir, "real.env"), join(dir, ".env"));
    const b = await writeSecretsEnvFile({
      rootDir: process.cwd(),
      worktreePath: dir,
      taskId: "FN-1",
      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
      worktreeSource: "fresh",
      audit: { filesystem },
      secretsStore: { listEnvExportable: vi.fn() } as any,
    });
    expect(b.reason).toBe("invalid-filename");
  });

  it("cleanup removes only fingerprint-matching env", async () => {
    const dir = tmpWorktree();
    const filesystem = vi.fn();
    const secretsStore = {
      listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]),
    } as any;

    await writeSecretsEnvFile({
      rootDir: process.cwd(),
      worktreePath: dir,
      taskId: "FN-1",
      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
      worktreeSource: "fresh",
      secretsStore,
    });

    const cleaned = await cleanupSecretsEnvFile({
      worktreePath: dir,
      taskId: "FN-1",
      expectedFingerprint: null,
      filename: ".env",
      audit: { filesystem },
    });
    expect(cleaned.outcome).toBe("cleaned");
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(existsSync(join(dir, ".fusion-secrets-env.fingerprint"))).toBe(false);

    await writeSecretsEnvFile({
      rootDir: process.cwd(),
      worktreePath: dir,
      taskId: "FN-1",
      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
      worktreeSource: "fresh",
      secretsStore,
    });
    writeFileSync(join(dir, ".env"), "MUTATED=1\n");
    const skipped = await cleanupSecretsEnvFile({
      worktreePath: dir,
      taskId: "FN-1",
      expectedFingerprint: null,
      filename: ".env",
      audit: { filesystem },
    });
    expect(skipped.reason).toBe("fingerprint-mismatch");
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(existsSync(join(dir, ".fusion-secrets-env.fingerprint"))).toBe(false);
  });
});

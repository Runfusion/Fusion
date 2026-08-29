import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanupSecretsEnvFile, reconcileSecretsEnvFingerprint, writeSecretsEnvFile } from "../worktree/secrets-env-writer.js";

const dirs: string[] = [];

function tmpWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "secrets-env-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
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
    const sidecar = readFileSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"), "utf8");
    expect(sidecar).toContain(".env");
    expect(existsSync(join(dir, ".fusion-secrets-env.fingerprint"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, ".git", ".fusion-secrets-env.fingerprint")).mode & 0o777).toBe(0o600);
    }

    const outputBlob = JSON.stringify({ calls: filesystem.mock.calls, logs: log.mock.calls, warns: warn.mock.calls });
    expect(outputBlob).not.toContain(secretValue);
  });

  it("writes an ignored configured file and records a redacted production audit", async () => {
    const dir = tmpWorktree();
    const filesystem = vi.fn();
    const secretValue = "runtime-materialized-secret";
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), ".secrets.env\n");

    const result = await writeSecretsEnvFile({
      rootDir: dir,
      worktreePath: dir,
      taskId: "FN-8810",
      settings: { secretsEnv: { enabled: true, filename: ".secrets.env" } },
      worktreeSource: "fresh",
      audit: { filesystem },
      secretsStore: {
        listEnvExportable: vi.fn().mockResolvedValue([
          { id: "1", key: "runtime-key", exportKey: "RUNTIME_SECRET", scope: "project", plaintextValue: secretValue },
        ]),
      } as any,
    });

    expect(result).toMatchObject({ outcome: "written", filename: ".secrets.env", keyCount: 1 });
    const exportedKeys = readFileSync(join(dir, ".secrets.env"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=", 1)[0]);
    expect(exportedKeys).toContain("RUNTIME_SECRET");
    expect(filesystem).toHaveBeenCalledWith(expect.objectContaining({
      type: "secret:env-write",
      metadata: expect.objectContaining({ keyCount: 1, fingerprint: expect.any(String) }),
    }));
    expect(JSON.stringify(filesystem.mock.calls)).not.toContain(secretValue);
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

  it("adopts a valid legacy record before strict porcelain and preserves ambiguous records", async () => {
    const dir = tmpWorktree();
    const fingerprint = "a".repeat(64);
    const legacy = join(dir, ".fusion-secrets-env.fingerprint");
    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
    writeFileSync(legacy, `${fingerprint}\n.env\n`);

    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "adopted-legacy" });
    expect(readFileSync(privateRecord, "utf8")).toBe(`${fingerprint}\n.env\n`);
    expect(existsSync(legacy)).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");

    writeFileSync(legacy, `${"b".repeat(64)}\n.env\n`);
    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "conflict" });
    expect(readFileSync(privateRecord, "utf8")).toBe(`${fingerprint}\n.env\n`);
    expect(readFileSync(legacy, "utf8")).toBe(`${"b".repeat(64)}\n.env\n`);
  });

  it("refuses materialization when record reconciliation is malformed or conflicting", async () => {
    const dir = tmpWorktree();
    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
    const legacyRecord = join(dir, ".fusion-secrets-env.fingerprint");
    const env = join(dir, ".env");
    const filesystem = vi.fn();
    const secretValue = "must-not-replace-existing-authority";
    const originalEnv = "PRESERVE=1\n";
    writeFileSync(env, originalEnv);
    writeFileSync(privateRecord, `${"a".repeat(64)}\n.env\n`);
    writeFileSync(legacyRecord, `${"b".repeat(64)}\n.env\n`);

    const result = await writeSecretsEnvFile({
      rootDir: dir,
      worktreePath: dir,
      taskId: "FN-8825",
      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
      worktreeSource: "fresh",
      audit: { filesystem },
      secretsStore: {
        listEnvExportable: vi.fn().mockResolvedValue([
          { id: "1", key: "SECRET", exportKey: "SECRET", scope: "project", plaintextValue: secretValue },
        ]),
      } as any,
    });

    expect(result).toEqual({ outcome: "skipped", filename: ".env", reason: "record-reconciliation-failed" });
    expect(readFileSync(env, "utf8")).toBe(originalEnv);
    expect(readFileSync(privateRecord, "utf8")).toBe(`${"a".repeat(64)}\n.env\n`);
    expect(readFileSync(legacyRecord, "utf8")).toBe(`${"b".repeat(64)}\n.env\n`);
    expect(filesystem).toHaveBeenCalledWith(expect.objectContaining({
      type: "secret:env-write-skipped",
      metadata: { reason: "record-reconciliation-failed", reconciliationOutcome: "conflict" },
    }));
    expect(JSON.stringify(filesystem.mock.calls)).not.toContain(secretValue);
  });

  it("does not replace a sole malformed record during materialization", async () => {
    const dir = tmpWorktree();
    const legacyRecord = join(dir, ".fusion-secrets-env.fingerprint");
    const env = join(dir, ".env");
    writeFileSync(legacyRecord, "not-a-fingerprint\n.env\n");
    writeFileSync(env, "PRESERVE=1\n");

    const result = await writeSecretsEnvFile({
      rootDir: dir,
      worktreePath: dir,
      taskId: "FN-8825",
      settings: { secretsEnv: { enabled: true, requireGitignored: false } },
      worktreeSource: "fresh",
      secretsStore: {
        listEnvExportable: vi.fn().mockResolvedValue([
          { id: "1", key: "SECRET", exportKey: "SECRET", scope: "project", plaintextValue: "new-value" },
        ]),
      } as any,
    });

    expect(result.reason).toBe("record-reconciliation-failed");
    expect(readFileSync(env, "utf8")).toBe("PRESERVE=1\n");
    expect(readFileSync(legacyRecord, "utf8")).toBe("not-a-fingerprint\n.env\n");
  });

  it("preserves legacy authority and converges after private durable replacement fails", async () => {
    const dir = tmpWorktree();
    const legacy = join(dir, ".fusion-secrets-env.fingerprint");
    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
    const contents = `${"a".repeat(64)}\n.env\n`;
    writeFileSync(legacy, contents);
    // A directory at the destination makes the atomic rename fail after the temporary record sync.
    mkdirSync(privateRecord);

    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "private-record-write-failed" });
    expect(readFileSync(legacy, "utf8")).toBe(contents);
    expect(existsSync(privateRecord)).toBe(true);

    rmSync(privateRecord, { recursive: true });
    // FNXC:SecretsEnvMaterialization 2026-08-08-03:30: A failed private durability barrier retains legacy authority so the next acquisition can safely converge.
    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "adopted-legacy" });
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(privateRecord, "utf8")).toBe(contents);
  });

  it("re-establishes private durability before removing an equal legacy record on retry", async () => {
    const dir = tmpWorktree();
    const legacy = join(dir, ".fusion-secrets-env.fingerprint");
    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
    const contents = `${"a".repeat(64)}\n.env\n`;
    // FNXC:SecretsEnvMaterialization 2026-08-08-03:42: Simulate interruption after rename before private-directory durability completes.
    writeFileSync(privateRecord, contents);
    writeFileSync(legacy, contents);

    await expect(reconcileSecretsEnvFingerprint(dir, {
      writePrivateRecord: async () => { throw new Error("private-directory-sync-failed"); },
    })).resolves.toEqual({ executionSafe: false, outcome: "private-record-write-failed" });
    expect(readFileSync(privateRecord, "utf8")).toBe(contents);
    expect(readFileSync(legacy, "utf8")).toBe(contents);

    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "removed-legacy" });
    expect(readFileSync(privateRecord, "utf8")).toBe(contents);
    expect(existsSync(legacy)).toBe(false);
  });

  it("re-establishes private durability before private-only retry can authorize refresh", async () => {
    const dir = tmpWorktree();
    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
    const contents = `${"a".repeat(64)}\n.secrets.env\n`;
    // FNXC:SecretsEnvMaterialization 2026-08-08-04:06: Model a failed write after rename when only its readable private artifact survived.
    writeFileSync(privateRecord, contents);

    await expect(reconcileSecretsEnvFingerprint(dir, {
      writePrivateRecord: async () => { throw new Error("private-directory-sync-failed"); },
    })).resolves.toEqual({ executionSafe: false, outcome: "private-record-write-failed" });
    expect(readFileSync(privateRecord, "utf8")).toBe(contents);

    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "clean" });
    expect(readFileSync(privateRecord, "utf8")).toBe(contents);
  });

  it("fails closed and converges after every private and root durability boundary interruption", async () => {
    const boundaries = ["temporary-file-synced", "private-record-renamed", "private-directory-synced", "legacy-unlinked", "root-directory-synced"] as const;
    for (const boundary of boundaries) {
      const dir = tmpWorktree();
      const legacy = join(dir, ".fusion-secrets-env.fingerprint");
      const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
      const contents = `${"a".repeat(64)}\n.secrets.env\n`;
      writeFileSync(legacy, contents);
      const observed: string[] = [];

      const blocked = await reconcileSecretsEnvFingerprint(dir, {
        durabilityBoundary: async (stage) => {
          observed.push(stage);
          if (stage === boundary) throw new Error(`interrupted-${stage}`);
        },
      });

      expect(observed).toContain(boundary);
      expect(blocked.executionSafe).toBe(false);
      if (boundary === "legacy-unlinked" || boundary === "root-directory-synced") {
        expect(existsSync(privateRecord)).toBe(true);
        expect(existsSync(legacy)).toBe(false);
      } else {
        // FNXC:SecretsEnvMaterialization 2026-08-08-03:51: No private barrier failure may discard the only v0.75.1 root authority.
        expect(readFileSync(legacy, "utf8")).toBe(contents);
      }
      await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toMatchObject({ executionSafe: true });
      expect(readFileSync(privateRecord, "utf8")).toBe(contents);
      expect(existsSync(legacy)).toBe(false);
    }
  });

  it("records the complete durable adoption order before porcelain may run", async () => {
    const dir = tmpWorktree();
    writeFileSync(join(dir, ".fusion-secrets-env.fingerprint"), `${"a".repeat(64)}\n.secrets.env\n`);
    const observed: string[] = [];

    await expect(reconcileSecretsEnvFingerprint(dir, {
      durabilityBoundary: async (boundary) => { observed.push(boundary); },
    })).resolves.toMatchObject({ executionSafe: true, outcome: "adopted-legacy" });

    expect(observed).toEqual([
      "temporary-file-synced",
      "private-record-renamed",
      "private-directory-synced",
      "legacy-unlinked",
      "root-directory-synced",
    ]);
  });

  it("fails closed for a sole malformed record without deleting it", async () => {
    const dir = tmpWorktree();
    const legacy = join(dir, ".fusion-secrets-env.fingerprint");
    writeFileSync(legacy, "malformed\n.env\n");
    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "invalid-record" });
    expect(readFileSync(legacy, "utf8")).toBe("malformed\n.env\n");
  });

  it("never adopts or removes a tracked root record", async () => {
    const dir = tmpWorktree();
    const legacy = join(dir, ".fusion-secrets-env.fingerprint");
    const contents = `${"a".repeat(64)}\n.env\n`;
    writeFileSync(legacy, contents);
    execFileSync("git", ["add", ".fusion-secrets-env.fingerprint"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "tracked root record"], { cwd: dir });

    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "tracked-record" });
    expect(readFileSync(legacy, "utf8")).toBe(contents);
    expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(false);
  });

  it("reconciles every unambiguous private and legacy record pairing", async () => {
    const dir = tmpWorktree();
    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
    const legacyRecord = join(dir, ".fusion-secrets-env.fingerprint");
    const first = `${"a".repeat(64)}\n.env\n`;
    const second = `${"b".repeat(64)}\n.secrets.env\n`;

    writeFileSync(privateRecord, first);
    // FNXC:SecretsEnvMaterialization 2026-08-08-03:02: v0.75.1 emitted the terminal LF, but legacy compatibility tolerates its missing final LF when both fields remain exact.
    writeFileSync(legacyRecord, first.trimEnd());
    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "removed-legacy" });
    expect(existsSync(legacyRecord)).toBe(false);

    writeFileSync(privateRecord, first.trimEnd());
    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "invalid-record" });
    writeFileSync(privateRecord, first);

    writeFileSync(privateRecord, "broken\n.env\n");
    writeFileSync(legacyRecord, second);
    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "recovered-private" });
    expect(readFileSync(privateRecord, "utf8")).toBe(second);
    expect(existsSync(legacyRecord)).toBe(false);

    writeFileSync(legacyRecord, "broken\n.env\n");
    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: true, outcome: "removed-legacy" });
    expect(readFileSync(privateRecord, "utf8")).toBe(second);
    expect(existsSync(legacyRecord)).toBe(false);

    writeFileSync(privateRecord, "broken\n.env\n");
    await expect(reconcileSecretsEnvFingerprint(dir)).resolves.toEqual({ executionSafe: false, outcome: "invalid-record" });
    expect(readFileSync(privateRecord, "utf8")).toBe("broken\n.env\n");
  });

  it("reconciles invalid legacy metadata to a valid private record before cleanup", async () => {
    const dir = tmpWorktree();
    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
    await writeSecretsEnvFile({ rootDir: dir, worktreePath: dir, taskId: "FN-1", settings: { secretsEnv: { enabled: true, requireGitignored: false } }, worktreeSource: "fresh", secretsStore });
    writeFileSync(join(dir, ".fusion-secrets-env.fingerprint"), "broken\n.env\n");
    await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toMatchObject({ outcome: "cleaned" });
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(existsSync(join(dir, ".fusion-secrets-env.fingerprint"))).toBe(false);
  });

  it("fails closed rather than using legacy orphan cleanup when a Git worktree cannot resolve its private dir", async () => {
    const dir = tmpWorktree();
    const body = "A=1\n";
    writeFileSync(join(dir, ".env"), body);
    writeFileSync(join(dir, ".fusion-secrets-env.fingerprint"), `${createHash("sha256").update(body).digest("hex")}\n.env\n`);
    renameSync(join(dir, ".git"), join(dir, ".git-unavailable"));
    writeFileSync(join(dir, ".git"), "gitdir: /missing-private-git-dir\n");

    await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toEqual({ outcome: "skipped", reason: "invalid-record" });
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(existsSync(join(dir, ".fusion-secrets-env.fingerprint"))).toBe(true);
  });

  it("cleanup safely handles missing, repeated, and non-Git legacy records", async () => {
    const dir = tmpWorktree();
    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
    await writeSecretsEnvFile({ rootDir: dir, worktreePath: dir, taskId: "FN-1", settings: { secretsEnv: { enabled: true, requireGitignored: false } }, worktreeSource: "fresh", secretsStore });
    rmSync(join(dir, ".env"));
    await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toMatchObject({ outcome: "skipped", reason: "file-missing" });
    expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(false);
    await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toMatchObject({ outcome: "skipped", reason: "no-record" });

    const orphan = mkdtempSync(join(tmpdir(), "secrets-env-orphan-"));
    dirs.push(orphan);
    const body = "A=1\n";
    writeFileSync(join(orphan, ".env"), body);
    writeFileSync(join(orphan, ".fusion-secrets-env.fingerprint"), `${createHash("sha256").update(body).digest("hex")}\n.env\n`);
    await expect(cleanupSecretsEnvFile({ worktreePath: orphan, taskId: "orphan", expectedFingerprint: null, filename: ".env" })).resolves.toMatchObject({ outcome: "cleaned", reason: "fingerprint-match" });
    expect(existsSync(join(orphan, ".env"))).toBe(false);
    expect(existsSync(join(orphan, ".fusion-secrets-env.fingerprint"))).toBe(false);
  });

  it("does not report cleanup success when private metadata removal fails", async () => {
    const dir = tmpWorktree();
    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
    await writeSecretsEnvFile({ rootDir: dir, worktreePath: dir, taskId: "FN-1", settings: { secretsEnv: { enabled: true, requireGitignored: false } }, worktreeSource: "fresh", secretsStore });
    const privateRecord = join(dir, ".git", ".fusion-secrets-env.fingerprint");
    // FNXC:SecretsEnvMaterialization 2026-08-08-03:30: A failed bookkeeping removal is retryable but must never be published as successful cleanup.
    await expect(cleanupSecretsEnvFile({
      worktreePath: dir,
      taskId: "FN-1",
      expectedFingerprint: null,
      filename: ".env",
      removeRecordPaths: async () => { throw new Error("metadata removal failed"); },
    })).resolves.toEqual({ outcome: "skipped", reason: "record-remove-failed" });
    expect(existsSync(privateRecord)).toBe(true);
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
    expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(false);

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
    expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(false);
  });

  it("never deletes a tracked env even when its fingerprint matches", async () => {
    const dir = tmpWorktree();
    const secretsStore = { listEnvExportable: vi.fn().mockResolvedValue([{ id: "1", key: "A", exportKey: "ALPHA", scope: "project", plaintextValue: "v" }]) } as any;
    await writeSecretsEnvFile({ rootDir: dir, worktreePath: dir, taskId: "FN-1", settings: { secretsEnv: { enabled: true, requireGitignored: false } }, worktreeSource: "fresh", secretsStore });
    execFileSync("git", ["add", ".env"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "tracked environment"], { cwd: dir });

    await expect(cleanupSecretsEnvFile({ worktreePath: dir, taskId: "FN-1", expectedFingerprint: null, filename: ".env" })).resolves.toEqual({ outcome: "skipped", reason: "tracked-file" });
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(existsSync(join(dir, ".git", ".fusion-secrets-env.fingerprint"))).toBe(true);
  });
});

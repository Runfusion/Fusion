import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { ProjectSettings, SecretsStore } from "@fusion/core";
import type { RunAuditor } from "../util/run-audit.js";

const FINGERPRINT_FILE = ".fusion-secrets-env.fingerprint";
const HEADER_PREFIX = "# Managed by Fusion — do not edit by hand.";
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type WriteSkipReason = "disabled" | "no-secrets" | "not-gitignored" | "skip-existing" | "invalid-filename" | "no-store" | "list-failed";
export type CleanupSkipReason = "fingerprint-mismatch" | "file-missing" | "no-record" | "disabled" | "stat-failed";

export interface WriteSecretsEnvFileOptions {
  rootDir: string;
  worktreePath: string;
  taskId: string;
  settings: Pick<ProjectSettings, "secretsEnv">;
  worktreeSource: "pool" | "fresh";
  secretsStore?: Pick<SecretsStore, "listEnvExportable">;
  audit?: Pick<RunAuditor, "filesystem">;
  logger?: { log: (m: string) => void; warn: (m: string) => void; error?: (m: string) => void };
  execFileImpl?: typeof execFile;
}

export interface WriteSecretsEnvFileResult {
  outcome: "written" | "skipped";
  filename: string;
  reason?: WriteSkipReason;
  keyCount?: number;
  fingerprint?: string;
}

export interface CleanupSecretsEnvFileOptions {
  worktreePath: string;
  taskId: string;
  expectedFingerprint: string | null;
  filename: string;
  audit?: Pick<RunAuditor, "filesystem">;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

export interface CleanupSecretsEnvFileResult {
  outcome: "cleaned" | "skipped";
  reason?: CleanupSkipReason | "fingerprint-match" | "directory-missing";
}

function isValidFilename(filename: string): boolean {
  return !!filename && !filename.includes("/") && !filename.includes("\\") && !filename.includes("..") && !filename.includes("\0") && filename !== FINGERPRINT_FILE;
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t")}"`;
}

function toManagedBody(taskId: string, entries: Array<{ exportKey: string; plaintextValue: string }>): string {
  const header = `${HEADER_PREFIX} (task: ${taskId})\n`;
  const body = entries
    .sort((a, b) => a.exportKey.localeCompare(b.exportKey))
    .map((item) => `${item.exportKey}=${quote(item.plaintextValue)}`)
    .join("\n");
  return `${header}${body}\n`;
}

function removeManagedBlock(input: string): string {
  const idx = input.indexOf(HEADER_PREFIX);
  if (idx === -1) return input;
  return input.slice(0, idx).replace(/\n+$/u, "\n");
}

async function checkIgnored(execImpl: typeof execFile, worktreePath: string, filename: string): Promise<{ ignored: boolean; error?: string }> {
  return await new Promise((resolve) => {
    execImpl("git", ["check-ignore", "--", filename], { cwd: worktreePath, timeout: 10_000 }, (error) => {
      if (!error) {
        resolve({ ignored: true });
        return;
      }
      const anyErr = error as NodeJS.ErrnoException & { code?: number };
      if (anyErr.code === 1) {
        resolve({ ignored: false });
        return;
      }
      resolve({ ignored: false, error: anyErr.message });
    });
  });
}

export async function writeSecretsEnvFile(opts: WriteSecretsEnvFileOptions): Promise<WriteSecretsEnvFileResult> {
  const cfg = opts.settings.secretsEnv;
  const filename = cfg?.filename ?? ".env";
  const overwritePolicy = cfg?.overwritePolicy ?? "merge";
  if (cfg?.enabled !== true) return { outcome: "skipped", filename, reason: "disabled" };
  if (!opts.secretsStore) {
    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "no-store" } });
    return { outcome: "skipped", filename, reason: "no-store" };
  }
  if (!isValidFilename(filename)) {
    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "invalid-filename", overwritePolicy } });
    return { outcome: "skipped", filename, reason: "invalid-filename" };
  }

  const envPath = path.join(opts.worktreePath, filename);
  try {
    const stat = await fs.lstat(envPath);
    if (stat.isSymbolicLink()) {
      await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "invalid-filename", overwritePolicy, symlink: true } });
      return { outcome: "skipped", filename, reason: "invalid-filename" };
    }
  } catch { /* file may not exist */ }

  if (cfg?.requireGitignored !== false) {
    const check = await checkIgnored(opts.execFileImpl ?? execFile, opts.worktreePath, filename);
    if (!check.ignored) {
      await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "not-gitignored", overwritePolicy, checkIgnoreError: check.error } });
      return { outcome: "skipped", filename, reason: "not-gitignored" };
    }
  }

  let listed: Awaited<ReturnType<NonNullable<typeof opts.secretsStore>["listEnvExportable"]>>;
  try {
    listed = await opts.secretsStore.listEnvExportable({ keyPrefix: cfg?.keyPrefix });
  } catch {
    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "list-failed", overwritePolicy } });
    return { outcome: "skipped", filename, reason: "list-failed" };
  }

  const valid = listed.filter((entry) => {
    if (!VALID_ENV_KEY.test(entry.exportKey)) {
      opts.logger?.warn(`secrets-env: skipping invalid export key ${entry.exportKey}`);
      return false;
    }
    return true;
  });

  if (valid.length === 0) {
    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "no-secrets", overwritePolicy } });
    return { outcome: "skipped", filename, reason: "no-secrets" };
  }

  let nextBody = toManagedBody(opts.taskId, valid);
  if (overwritePolicy === "skip") {
    try {
      await fs.access(envPath);
      await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "skip-existing", overwritePolicy } });
      return { outcome: "skipped", filename, reason: "skip-existing" };
    } catch { /* file does not exist — proceed to write */ }
  } else if (overwritePolicy === "merge") {
    try {
      const existing = await fs.readFile(envPath, "utf8");
      const preserved = removeManagedBlock(existing);
      nextBody = `${preserved.replace(/\n*$/u, "")}${preserved.length > 0 ? "\n" : ""}${nextBody}`;
    } catch { /* file does not exist — write fresh */ }
  }

  const tmpPath = `${envPath}.fusion-tmp`;
  await fs.writeFile(tmpPath, nextBody, { mode: 0o600, encoding: "utf8" });
  await fs.rename(tmpPath, envPath);
  await fs.chmod(envPath, 0o600).catch(() => undefined);

  const fingerprint = sha256(nextBody);
  const sidecarPath = path.join(opts.worktreePath, FINGERPRINT_FILE);
  await fs.writeFile(sidecarPath, `${fingerprint}\n${filename}\n`, { mode: 0o600, encoding: "utf8" });
  await fs.chmod(sidecarPath, 0o600).catch(() => undefined);

  const keys = valid.map((entry) => entry.exportKey).sort((a, b) => a.localeCompare(b));
  await opts.audit?.filesystem({ type: "secret:env-write", target: opts.taskId, metadata: { filename, keyCount: keys.length, fingerprint, overwritePolicy, keys } });
  opts.logger?.log(`secrets-env: wrote ${filename} (${keys.length} keys)`);
  return { outcome: "written", filename, keyCount: keys.length, fingerprint };
}

export async function cleanupSecretsEnvFile(opts: CleanupSecretsEnvFileOptions): Promise<CleanupSecretsEnvFileResult> {
  const sidecarPath = path.join(opts.worktreePath, FINGERPRINT_FILE);
  try {
    await fs.access(opts.worktreePath);
  } catch {
    await opts.audit?.filesystem({ type: "secret:env-cleanup", target: opts.taskId, metadata: { filename: opts.filename, fingerprint: opts.expectedFingerprint, reason: "directory-missing" } });
    return { outcome: "cleaned", reason: "directory-missing" };
  }

  let sidecar: string;
  try {
    sidecar = await fs.readFile(sidecarPath, "utf8");
  } catch {
    await opts.audit?.filesystem({ type: "secret:env-cleanup-skipped", target: opts.taskId, metadata: { filename: opts.filename, reason: "no-record" } });
    return { outcome: "skipped", reason: "no-record" };
  }

  const [fingerprint = "", filename = ""] = sidecar.split(/\n/u);
  if (!isValidFilename(filename)) {
    await opts.audit?.filesystem({ type: "secret:env-cleanup-skipped", target: opts.taskId, metadata: { filename, reason: "stat-failed" } });
    return { outcome: "skipped", reason: "stat-failed" };
  }

  const envPath = path.join(opts.worktreePath, filename);
  let body: string;
  try {
    body = await fs.readFile(envPath, "utf8");
  } catch {
    await fs.unlink(sidecarPath).catch(() => undefined);
    await opts.audit?.filesystem({ type: "secret:env-cleanup-skipped", target: opts.taskId, metadata: { filename, reason: "file-missing" } });
    return { outcome: "skipped", reason: "file-missing" };
  }

  if (sha256(body) !== fingerprint) {
    await fs.unlink(sidecarPath).catch(() => undefined);
    await opts.audit?.filesystem({ type: "secret:env-cleanup-skipped", target: opts.taskId, metadata: { filename, reason: "fingerprint-mismatch" } });
    return { outcome: "skipped", reason: "fingerprint-mismatch" };
  }

  await fs.unlink(envPath);
  await fs.unlink(sidecarPath).catch(() => undefined);
  await opts.audit?.filesystem({ type: "secret:env-cleanup", target: opts.taskId, metadata: { filename, fingerprint, reason: "fingerprint-match" } });
  return { outcome: "cleaned", reason: "fingerprint-match" };
}

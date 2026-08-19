import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectSettings, SecretsStore } from "@fusion/core";
import type { RunAuditor } from "../util/run-audit.js";

export const FINGERPRINT_FILE = ".fusion-secrets-env.fingerprint";
const HEADER_PREFIX = "# Managed by Fusion — do not edit by hand.";
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALID_FINGERPRINT = /^[0-9a-f]{64}$/;
const execFileAsync = promisify(execFile);

export type WriteSkipReason = "disabled" | "no-secrets" | "not-gitignored" | "skip-existing" | "invalid-filename" | "no-store" | "list-failed" | "record-reconciliation-failed";
export type CleanupSkipReason = "fingerprint-mismatch" | "file-missing" | "file-retained" | "no-record" | "disabled" | "stat-failed" | "ambiguous-record" | "invalid-record" | "tracked-file" | "record-remove-failed";
export type FingerprintReconciliationOutcome = "clean" | "adopted-legacy" | "removed-legacy" | "recovered-private" | "conflict" | "invalid-record" | "tracked-record" | "git-dir-unavailable" | "private-record-write-failed" | "legacy-remove-failed";

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
  /** Allow legacy cleanup only after the orphan reaper has positively proven a dangling gitdir. */
  allowLegacyCleanupForDanglingGitdir?: boolean;
  /**
   * Current-state revalidation for legacy orphan cleanup: called at the authorization
   * boundary (after the awaited private-dir resolution) so the orphan reaper's earlier
   * dangling verdict cannot authorize deleting a tracked .env from a worktree that a
   * concurrent repair made live again.
   */
  isDanglingGitdir?: () => boolean;
  audit?: Pick<RunAuditor, "filesystem">;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  /** Test seam for proving cleanup never converts metadata-removal failures into success. */
  removeRecordPaths?: (recordPaths: string[]) => Promise<void>;
  /** Test seam for proving ownership is revalidated at the deletion boundary. */
  readFileImpl?: typeof fs.readFile;
  /** Test seam for proving the pathname is atomically quarantined before removal. */
  renameFileImpl?: typeof fs.rename;
  /** Run the destructive worktree removal while the managed inode is quarantined. */
  onVerifiedBeforeDelete?: () => Promise<void>;
}

export interface CleanupSecretsEnvFileResult {
  outcome: "cleaned" | "skipped";
  reason?: CleanupSkipReason | "fingerprint-match" | "directory-missing";
}

export interface ReconcileSecretsEnvFingerprintResult {
  executionSafe: boolean;
  outcome: FingerprintReconciliationOutcome;
}

interface ReconcileSecretsEnvFingerprintOptions {
  /** Test seam for proving a legacy record survives every private durability barrier failure. */
  writePrivateRecord?: (recordPath: string, fingerprint: string, filename: string) => Promise<void>;
  /** Test seam that models an interruption at each durable migration boundary. */
  durabilityBoundary?: (boundary: "temporary-file-synced" | "private-record-renamed" | "private-directory-synced" | "legacy-unlinked" | "root-directory-synced") => Promise<void>;
}

interface FingerprintRecord {
  fingerprint: string;
  filename: string;
  raw: string;
  path: string;
}

type RecordState = { kind: "absent" } | { kind: "invalid"; path: string } | { kind: "valid"; record: FingerprintRecord };

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
  const body = entries.sort((a, b) => a.exportKey.localeCompare(b.exportKey)).map((item) => `${item.exportKey}=${quote(item.plaintextValue)}`).join("\n");
  return `${header}${body}\n`;
}

function removeManagedBlock(input: string): string {
  const idx = input.indexOf(HEADER_PREFIX);
  if (idx === -1) return input;
  return input.slice(0, idx).replace(/\n+$/u, "\n");
}

type RecordFormat = "private" | "legacy";

function parseRecord(raw: string, recordPath: string, format: RecordFormat): FingerprintRecord | undefined {
  // FNXC:SecretsEnvMaterialization 2026-08-08-03:02: v0.75.1 wrote root metadata without a marker; private records require a terminal LF so partial bookkeeping cannot authorize deletion.
  const match = (format === "private"
    ? /^([0-9a-f]{64})\n([^\n]+)\n$/u
    : /^([0-9a-f]{64})\n([^\n]+)\n?$/u).exec(raw);
  if (!match || !VALID_FINGERPRINT.test(match[1]) || !isValidFilename(match[2])) return undefined;
  return { fingerprint: match[1], filename: match[2], raw, path: recordPath };
}

async function readRecord(recordPath: string, format: RecordFormat): Promise<RecordState> {
  try {
    const raw = await fs.readFile(recordPath, "utf8");
    const record = parseRecord(raw, recordPath, format);
    return record ? { kind: "valid", record } : { kind: "invalid", path: recordPath };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "invalid", path: recordPath };
  }
}

/**
 * FNXC:SecretsEnvMaterialization 2026-08-07-23:13:
 * Fingerprint metadata is Fusion bookkeeping, not project content. Resolve the linked worktree's private
 * Git directory asynchronously so secret materialization cannot create an untracked root sidecar that blocks
 * the next strict worktree base refresh.
 */
async function resolvePrivateRecordPath(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: worktreePath, encoding: "utf8", timeout: 10_000 });
  const gitDir = stdout.trim();
  if (!gitDir) throw new Error("git-dir-empty");
  return path.join(path.isAbsolute(gitDir) ? gitDir : path.resolve(worktreePath, gitDir), FINGERPRINT_FILE);
}

function isOwnedQuarantineArtifact(name: string, filename: string): boolean {
  return name.startsWith(`${filename}.fusion-cleanup-`) && /^.+\.fusion-cleanup-\d+-(?:[0-9a-f-]+(?:\.deleting)?|recovery)$/u.test(name);
}

/**
 * True when a worktree-relative porcelain path refers to a Fusion-owned env
 * quarantine artifact (`.env.fusion-cleanup-<pid>-<uuid>[.deleting]`). The
 * dirty probe uses this so removal never treats its own verified, parked
 * cleanup inode as user content.
 *
 * Ownership is NOT inferred from the predictable basename: a user-authored
 * ignored file could carry that quarantine-shaped name. The parked inode's
 * on-disk content must match the recorded fingerprint for the managed `.env`
 * (private git-dir record, falling back to the legacy root sidecar). Any
 * quarantine-named file that is not fingerprint-proven stays dirty (fail
 * closed) so a defensive removal refuses instead of deleting user content.
 */
export async function isOwnedEnvQuarantineArtifactPath(
  worktreePath: string,
  relativePath: string,
): Promise<boolean> {
  const unquoted = relativePath.trim().replace(/^"(.*)"$/u, "$1");
  if (!isOwnedQuarantineArtifact(path.basename(unquoted), ".env")) return false;
  if (path.isAbsolute(unquoted)) return false;
  let body: string;
  try {
    body = await fs.readFile(path.join(worktreePath, unquoted), "utf8");
  } catch {
    return false;
  }
  const candidate = sha256(body);
  const recordPaths: Array<[string, RecordFormat]> = [[path.join(worktreePath, FINGERPRINT_FILE), "legacy"]];
  const privatePath = await resolvePrivateRecordPath(worktreePath).catch(() => undefined);
  if (privatePath) recordPaths.unshift([privatePath, "private"]);
  for (const [recordPath, format] of recordPaths) {
    const state = await readRecord(recordPath, format);
    if (state.kind === "valid" && state.record.filename === ".env" && state.record.fingerprint === candidate) {
      return true;
    }
  }
  return false;
}

function recordsMatch(left: FingerprintRecord, right: FingerprintRecord): boolean {
  return left.fingerprint === right.fingerprint && left.filename === right.filename;
}

function directorySyncUnsupported(error: unknown): boolean {
  // FNXC:SecretsEnvMaterialization 2026-08-08-03:02: Windows cannot fsync directory handles. This narrow portability exception never conceals ordinary I/O errors.
  return process.platform === "win32" && ["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "");
}

async function syncParentDirectory(filePath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path.dirname(filePath), "r");
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * FNXC:SecretsEnvMaterialization 2026-08-08-03:02:
 * A renamed record is not crash-durable until the private Git directory is synced. The legacy root
 * authority must survive every failure before this barrier, so callers unlink it only after this returns.
 */
async function atomicWriteRecord(
  recordPath: string,
  fingerprint: string,
  filename: string,
  durabilityBoundary?: ReconcileSecretsEnvFingerprintOptions["durabilityBoundary"],
): Promise<void> {
  const tmpPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(tmpPath, "w", 0o600);
    await handle.writeFile(`${fingerprint}\n${filename}\n`, "utf8");
    await handle.sync();
    await durabilityBoundary?.("temporary-file-synced");
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, recordPath);
    await durabilityBoundary?.("private-record-renamed");
    await syncParentDirectory(recordPath);
    await durabilityBoundary?.("private-directory-synced");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * FNXC:SecretsEnvMaterialization 2026-08-08-03:15:
 * Root records from v0.75.1 are Fusion-owned only while untracked. Never adopt or remove a tracked
 * lookalike: a project may intentionally version that path, and fingerprint equality is not authority to delete it.
 */
async function isTrackedWorktreeFile(worktreePath: string, filename: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", filename], { cwd: worktreePath, encoding: "utf8", timeout: 10_000 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return false;
    throw error;
  }
}

async function removeLegacyRecord(
  worktreePath: string,
  legacyPath: string,
  durabilityBoundary?: ReconcileSecretsEnvFingerprintOptions["durabilityBoundary"],
): Promise<void> {
  if (await isTrackedWorktreeFile(worktreePath, FINGERPRINT_FILE)) throw new Error("legacy-record-tracked");
  try {
    await fs.unlink(legacyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await durabilityBoundary?.("legacy-unlinked");
  await syncParentDirectory(legacyPath);
  await durabilityBoundary?.("root-directory-synced");
}

/**
 * FNXC:SecretsEnvMaterialization 2026-08-08-03:30:
 * Cleanup may report a fingerprint match only after its bookkeeping is removed. Suppressing a metadata
 * removal error makes a later reuse look clean while retaining stale authority, so callers receive a fixed
 * non-success result and can safely retry instead.
 */
async function removeRecordPaths(recordPaths: string[]): Promise<void> {
  for (const recordPath of recordPaths) {
    try {
      await fs.unlink(recordPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await syncParentDirectory(recordPath);
  }
}

/**
 * FNXC:SecretsEnvMaterialization 2026-08-08-01:54:
 * Root legacy metadata must be removed before strict porcelain proceeds. A failed removal is not benign:
 * leaving Fusion's root file behind would recreate the dirty-worktree dispatch failure, so reconciliation
 * remains closed until the record can be safely reconciled.
 */
/** Reconcile v0.75.1 root metadata before porcelain is consulted. */
export async function reconcileSecretsEnvFingerprint(
  worktreePath: string,
  options: ReconcileSecretsEnvFingerprintOptions = {},
): Promise<ReconcileSecretsEnvFingerprintResult> {
  const legacyPath = path.join(worktreePath, FINGERPRINT_FILE);
  let privatePath: string;
  try {
    privatePath = await resolvePrivateRecordPath(worktreePath);
  } catch {
    return { executionSafe: false, outcome: "git-dir-unavailable" };
  }
  const [privateState, legacyState] = await Promise.all([readRecord(privatePath, "private"), readRecord(legacyPath, "legacy")]);
  if (privateState.kind === "absent" && legacyState.kind === "absent") return { executionSafe: true, outcome: "clean" };
  try {
    if (legacyState.kind !== "absent" && await isTrackedWorktreeFile(worktreePath, FINGERPRINT_FILE)) {
      return { executionSafe: false, outcome: "tracked-record" };
    }
  } catch {
    return { executionSafe: false, outcome: "git-dir-unavailable" };
  }
  if (privateState.kind === "invalid" && legacyState.kind !== "valid") return { executionSafe: false, outcome: "invalid-record" };
  if (legacyState.kind === "invalid" && privateState.kind !== "valid") return { executionSafe: false, outcome: "invalid-record" };
  if (privateState.kind === "valid" && legacyState.kind === "valid" && !recordsMatch(privateState.record, legacyState.record)) {
    return { executionSafe: false, outcome: "conflict" };
  }
  if (privateState.kind === "valid") {
    /*
     * FNXC:SecretsEnvMaterialization 2026-08-08-04:06:
     * A readable private record may have survived a failed write after rename but before its parent directory
     * was synced. Re-establish its file and directory durability on every private-record reconciliation,
     * including private-only retry, so a prior failed write cannot authorize refresh without that barrier.
     */
    try {
      await (options.writePrivateRecord
        ? options.writePrivateRecord(privatePath, privateState.record.fingerprint, privateState.record.filename)
        : atomicWriteRecord(privatePath, privateState.record.fingerprint, privateState.record.filename, options.durabilityBoundary));
    } catch {
      return { executionSafe: false, outcome: "private-record-write-failed" };
    }
    if (legacyState.kind !== "absent") {
      try {
        await removeLegacyRecord(worktreePath, legacyPath, options.durabilityBoundary);
      } catch {
        return { executionSafe: false, outcome: "legacy-remove-failed" };
      }
    }
    // FNXC:SecretsEnvMaterialization 2026-08-08-03:51: A crash after unlink but before root-directory sync leaves only private metadata. Re-sync the root on retry before this state can authorize refresh.
    if (legacyState.kind === "absent") {
      try {
        await syncParentDirectory(legacyPath);
      } catch {
        return { executionSafe: false, outcome: "legacy-remove-failed" };
      }
    }
    return { executionSafe: true, outcome: legacyState.kind === "absent" ? "clean" : "removed-legacy" };
  }
  /*
   * FNXC:SecretsEnvMaterialization 2026-08-08-03:02:
   * v0.75.1 root bytes remain cleanup authority until the replacement record and its private Git-directory
   * entry are durable. Only then may the root unlink occur; its directory sync is the final safe-to-refresh barrier.
   */
  if (legacyState.kind !== "valid") return { executionSafe: false, outcome: "invalid-record" };
  try {
    await (options.writePrivateRecord
      ? options.writePrivateRecord(privatePath, legacyState.record.fingerprint, legacyState.record.filename)
      : atomicWriteRecord(privatePath, legacyState.record.fingerprint, legacyState.record.filename, options.durabilityBoundary));
  } catch {
    return { executionSafe: false, outcome: "private-record-write-failed" };
  }
  try {
    await removeLegacyRecord(worktreePath, legacyPath, options.durabilityBoundary);
  } catch {
    return { executionSafe: false, outcome: "legacy-remove-failed" };
  }
  return { executionSafe: true, outcome: privateState.kind === "invalid" ? "recovered-private" : "adopted-legacy" };
}

async function checkIgnored(execImpl: typeof execFile, worktreePath: string, filename: string): Promise<{ ignored: boolean; error?: string }> {
  return await new Promise((resolve) => {
    execImpl("git", ["check-ignore", "--", filename], { cwd: worktreePath, timeout: 10_000 }, (error) => {
      if (!error) return resolve({ ignored: true });
      const anyErr = error as NodeJS.ErrnoException & { code?: number };
      if (anyErr.code === 1) return resolve({ ignored: false });
      return resolve({ ignored: false, error: anyErr.message });
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
  try { if ((await fs.lstat(envPath)).isSymbolicLink()) return { outcome: "skipped", filename, reason: "invalid-filename" }; } catch { /* absent is safe */ }
  if (cfg?.requireGitignored !== false) {
    const check = await checkIgnored(opts.execFileImpl ?? execFile, opts.worktreePath, filename);
    if (!check.ignored) {
      await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "not-gitignored", overwritePolicy, checkIgnoreError: check.error } });
      return { outcome: "skipped", filename, reason: "not-gitignored" };
    }
  }
  let listed: Awaited<ReturnType<NonNullable<typeof opts.secretsStore>["listEnvExportable"]>>;
  try { listed = await opts.secretsStore.listEnvExportable({ keyPrefix: cfg?.keyPrefix }); } catch {
    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "list-failed", overwritePolicy } });
    return { outcome: "skipped", filename, reason: "list-failed" };
  }
  const valid = listed.filter((entry) => VALID_ENV_KEY.test(entry.exportKey));
  if (valid.length === 0) {
    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "no-secrets", overwritePolicy } });
    return { outcome: "skipped", filename, reason: "no-secrets" };
  }
  /*
   * FNXC:SecretsEnvMaterialization 2026-08-08-03:59:
   * A materialization write must not bypass the same record matrix that protects refresh and cleanup.
   * Preserve malformed or conflicting bookkeeping and its existing env authority rather than replacing it
   * with a new private record; only an unambiguous, durably reconciled state may receive new metadata.
   */
  const reconciliation = await reconcileSecretsEnvFingerprint(opts.worktreePath);
  if (!reconciliation.executionSafe) {
    await opts.audit?.filesystem({
      type: "secret:env-write-skipped",
      target: opts.taskId,
      metadata: { reason: "record-reconciliation-failed", reconciliationOutcome: reconciliation.outcome },
    });
    return { outcome: "skipped", filename, reason: "record-reconciliation-failed" };
  }
  let nextBody = toManagedBody(opts.taskId, valid);
  if (overwritePolicy === "skip") {
    try { await fs.access(envPath); return { outcome: "skipped", filename, reason: "skip-existing" }; } catch { /* absent */ }
  } else if (overwritePolicy === "merge") {
    try { const preserved = removeManagedBlock(await fs.readFile(envPath, "utf8")); nextBody = `${preserved.replace(/\n*$/u, "")}${preserved.length ? "\n" : ""}${nextBody}`; } catch { /* absent */ }
  }
  const tmpPath = `${envPath}.fusion-tmp`;
  await fs.writeFile(tmpPath, nextBody, { mode: 0o600, encoding: "utf8" });
  await fs.rename(tmpPath, envPath);
  await fs.chmod(envPath, 0o600).catch(() => undefined);
  const fingerprint = sha256(nextBody);
  const privatePath = await resolvePrivateRecordPath(opts.worktreePath);
  await atomicWriteRecord(privatePath, fingerprint, filename);
  /*
   * FNXC:SecretsEnvMaterialization 2026-08-08-02:00:
   * A current private record supersedes root metadata only after it is durable. Do not swallow a legacy
   * removal failure: preserving that untracked root file would deterministically poison the next strict
   * refresh, so callers must observe the failed materialization rather than report a false clean write.
   */
  try {
    await removeLegacyRecord(opts.worktreePath, path.join(opts.worktreePath, FINGERPRINT_FILE));
  } catch {
    await opts.audit?.filesystem({ type: "secret:env-write-skipped", target: opts.taskId, metadata: { filename, reason: "legacy-remove-failed" } });
    throw new Error("secrets-env legacy record removal failed");
  }
  const keys = valid.map((entry) => entry.exportKey).sort((a, b) => a.localeCompare(b));
  await opts.audit?.filesystem({ type: "secret:env-write", target: opts.taskId, metadata: { filename, keyCount: keys.length, fingerprint, overwritePolicy, keys } });
  opts.logger?.log(`secrets-env: wrote ${filename} (${keys.length} keys)`);
  return { outcome: "written", filename, keyCount: keys.length, fingerprint };
}

export async function cleanupSecretsEnvFile(opts: CleanupSecretsEnvFileOptions): Promise<CleanupSecretsEnvFileResult> {
  const removeRecords = opts.removeRecordPaths ?? removeRecordPaths;
  const readFile = opts.readFileImpl ?? fs.readFile;
  const renameFile = opts.renameFileImpl ?? fs.rename;
  try { await fs.access(opts.worktreePath); } catch { return { outcome: "cleaned", reason: "directory-missing" }; }
  const legacyPath = path.join(opts.worktreePath, FINGERPRINT_FILE);
  let privatePath: string | undefined;
  try {
    privatePath = await resolvePrivateRecordPath(opts.worktreePath);
  } catch {
    /*
     * FNXC:SecretsEnvMaterialization 2026-08-17-16:45:
     * The orphan reaper's dangling verdict predates this awaited git/private-dir
     * resolution, which gave a concurrent repair time to recreate the admin entry
     * the pointer references. Legacy cleanup is authorized only while the pointer
     * is STILL positively dangling at this instant: a repaired worktree is live
     * again and its tracked .env must never be deleted on a stale verdict (the
     * tracked-file guard below runs only when a private path resolved).
     */
    const stillDangling = opts.allowLegacyCleanupForDanglingGitdir && (opts.isDanglingGitdir?.() ?? false);
    if (!stillDangling) {
      try {
        await fs.lstat(path.join(opts.worktreePath, ".git"));
        return { outcome: "skipped", reason: "invalid-record" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { outcome: "skipped", reason: "invalid-record" };
      }
    }
  }
  if (privatePath) {
    try {
      const reconciliation = await reconcileSecretsEnvFingerprint(opts.worktreePath);
      if (!reconciliation.executionSafe) return { outcome: "skipped", reason: reconciliation.outcome === "conflict" ? "ambiguous-record" : "invalid-record" };
    } catch {
      // A Git-backed cleanup must never downgrade a failed reconciliation into legacy-only cleanup.
      return { outcome: "skipped", reason: "invalid-record" };
    }
  }
  const [privateState, legacyState] = await Promise.all([privatePath ? readRecord(privatePath, "private") : Promise.resolve({ kind: "absent" } as RecordState), readRecord(legacyPath, "legacy")]);
  if (privateState.kind === "invalid" || legacyState.kind === "invalid") return { outcome: "skipped", reason: "invalid-record" };
  if (privateState.kind === "valid" && legacyState.kind === "valid" && !recordsMatch(privateState.record, legacyState.record)) return { outcome: "skipped", reason: "ambiguous-record" };
  const record = privateState.kind === "valid" ? privateState.record : legacyState.kind === "valid" ? legacyState.record : undefined;
  if (!record) return { outcome: "skipped", reason: "no-record" };
  const recordPaths = [privateState, legacyState].flatMap((state) => state.kind === "valid" && recordsMatch(state.record, record) ? [state.record.path] : []);
  let body: string;
  try { body = await readFile(path.join(opts.worktreePath, record.filename), "utf8"); } catch {
    // The managed pathname is missing. A previous cleanup may have quarantined
    // the inode (rename) before crashing; restore it to the pathname via an
    // exclusive link so the content is never stranded under the recovery prefix.
    // With no quarantine the managed file is simply gone and the record can drop.
    const quarantineEntries = (await fs.readdir(opts.worktreePath)).filter((name) => isOwnedQuarantineArtifact(name, record.filename));
    if (quarantineEntries.length === 0) {
      try {
        await removeRecords(recordPaths);
      } catch {
        return { outcome: "skipped", reason: "record-remove-failed" };
      }
      return { outcome: "skipped", reason: "file-missing" };
    }
    const quarantinePaths = quarantineEntries.map((name) => path.join(opts.worktreePath, name));
    let recoveredBody: string;
    try {
      recoveredBody = await readFile(quarantinePaths[0], "utf8");
      const recoveredBodies = await Promise.all(quarantinePaths.map((quarantinePath) => readFile(quarantinePath, "utf8")));
      if (recoveredBodies.some((candidate) => sha256(candidate) !== sha256(recoveredBody))) {
        return { outcome: "skipped", reason: "file-retained" };
      }
    } catch {
      return { outcome: "skipped", reason: "file-retained" };
    }
    try {
      await fs.link(quarantinePaths[0], path.join(opts.worktreePath, record.filename));
    } catch {
      // The pathname is occupied or the link failed: keep the recovery copy and
      // ownership record so a later retry can converge.
      return { outcome: "skipped", reason: "file-retained" };
    }
    // FNXC:SecretsEnvMaterialization 2026-08-18-19: Duplicate owned recovery copies may be left by interrupted cleanup. Reconcile only identical copies, then consume the recovery set after restoring one inode.
    await Promise.all(quarantinePaths.map((quarantinePath) => fs.unlink(quarantinePath).catch(() => undefined)));
    try {
      body = await readFile(path.join(opts.worktreePath, record.filename), "utf8");
    } catch {
      return { outcome: "skipped", reason: "record-remove-failed" };
    }
  }
  if (sha256(body) !== record.fingerprint) {
    try {
      const quarantineEntries = (await fs.readdir(opts.worktreePath)).filter((name) => isOwnedQuarantineArtifact(name, record.filename));
      for (const name of quarantineEntries) {
        const quarantinePath = path.join(opts.worktreePath, name);
        try {
          if (sha256(await readFile(quarantinePath, "utf8")) === record.fingerprint) {
            await fs.unlink(quarantinePath);
          } else {
            return { outcome: "skipped", reason: "file-retained" };
          }
        } catch {
          return { outcome: "skipped", reason: "file-retained" };
        }
      }
    } catch {
      // Preserve ownership metadata when quarantine state cannot be inspected.
      return { outcome: "skipped", reason: "file-retained" };
    }

    try {
      await removeRecords(recordPaths);
    } catch {
      return { outcome: "skipped", reason: "record-remove-failed" };
    }
    return { outcome: "skipped", reason: "fingerprint-mismatch" };
  }
  try {
    if (privatePath && await isTrackedWorktreeFile(opts.worktreePath, record.filename)) {
      return { outcome: "skipped", reason: "tracked-file" };
    }
  } catch {
    // Cleanup cannot prove ownership when Git cannot answer; preserve both content and record for retry.
    return { outcome: "skipped", reason: "tracked-file" };
  }
  // A pathname cannot be unlinked conditionally by Node: comparing it and then
  // unlinking it would be TOCTOU-unsafe. Rename the pathname into a private
  // quarantine name (atomic), re-verify the moved inode's content, then unlink
  // the quarantine. A concurrent replacement either lands at the freed pathname
  // (preserved) or is moved into quarantine and restored on mismatch; only the
  // verified managed inode is ever removed.
  const envPath = path.join(opts.worktreePath, record.filename);
  const quarantinePath = `${envPath}.fusion-cleanup-${process.pid}-${randomUUID()}`;
  // Follows the verified inode across its own quarantine rename so a recovery
  // restore after the deletion-shaped move still finds the content (the original
  // quarantinePath name is gone once quarantined under the .deleting pathname).
  let activeQuarantinePath = quarantinePath;
  try {
    await renameFile(envPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { outcome: "skipped", reason: "record-remove-failed" };
    }
    try {
      await removeRecords(recordPaths);
    } catch {
      return { outcome: "skipped", reason: "record-remove-failed" };
    }
    return { outcome: "skipped", reason: "file-missing" };
  }
  // Put the quarantined inode back at envPath without ever clobbering a newer
  // occupant (link fails with EEXIST); if the occupant already won, the
  // quarantined file is dropped. Returns false when the restore link failed for
  // a reason other than EEXIST: the quarantine is then the only surviving copy
  // of this content and must be preserved as a recovery file, never unlinked.
  const restoreQuarantine = async (): Promise<boolean> => {
    try {
      await fs.link(activeQuarantinePath, envPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        opts.logger?.warn(`secrets-env: restore link failed for quarantined ${record.filename}; preserved recovery copy at ${activeQuarantinePath}`);
        return false;
      }
      // The pathname is occupied, but the quarantined inode is unverified.
      // Keep it as recovery evidence; EEXIST is not proof it is safe to delete.
      return false;
    }
    await fs.unlink(activeQuarantinePath).catch(() => undefined);
    return true;
  };
  try {
    if (sha256(await readFile(quarantinePath, "utf8")) !== record.fingerprint) {
      // A concurrent replacement was moved into quarantine: restore it and drop
      // the stale bookkeeping (the managed content is already gone).
      if (!await restoreQuarantine()) return { outcome: "skipped", reason: "file-retained" };
      try {
        await removeRecords(recordPaths);
      } catch {
        return { outcome: "skipped", reason: "record-remove-failed" };
      }
      return { outcome: "skipped", reason: "fingerprint-mismatch" };
    }
  } catch {
    // The quarantined inode cannot be read (permissions): restore it and fail closed.
    await restoreQuarantine();
    return { outcome: "skipped", reason: "record-remove-failed" };
  }
  const quarantinedStat = await fs.lstat(quarantinePath);
  // ponytail: rename the verified inode away before unlink; the old pathname cannot be swapped under us.
  if (!privatePath && opts.allowLegacyCleanupForDanglingGitdir && !(opts.isDanglingGitdir?.() ?? false)) {
    await restoreQuarantine();
    return { outcome: "skipped", reason: "invalid-record" };
  }
  const deletionPath = `${quarantinePath}.deleting`;
  try {
    await fs.rename(quarantinePath, deletionPath);
    activeQuarantinePath = deletionPath;
    const deletionStat = await fs.lstat(deletionPath);
    if (deletionStat.dev !== quarantinedStat.dev || deletionStat.ino !== quarantinedStat.ino) {
      return { outcome: "skipped", reason: "file-retained" };
    }
    // FNXC:SecretsEnvMaterialization 2026-08-18-15: Revalidate after every awaited
    // boundary so a repaired dangling worktree cannot lose its managed inode.
    if (!privatePath && opts.allowLegacyCleanupForDanglingGitdir && !(opts.isDanglingGitdir?.() ?? false)) {
      await restoreQuarantine();
      return { outcome: "skipped", reason: "invalid-record" };
    }
    await opts.onVerifiedBeforeDelete?.();
    await fs.unlink(deletionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      try { await restoreQuarantine(); } catch { /* retain recovery copy */ }
      return { outcome: "skipped", reason: "record-remove-failed" };
    }
  }
  try {
    await removeRecords(recordPaths);
  } catch {
    return { outcome: "skipped", reason: "record-remove-failed" };
  }
  await opts.audit?.filesystem({ type: "secret:env-cleanup", target: opts.taskId, metadata: { filename: record.filename, fingerprint: record.fingerprint, reason: "fingerprint-match" } });
  return { outcome: "cleaned", reason: "fingerprint-match" };
}

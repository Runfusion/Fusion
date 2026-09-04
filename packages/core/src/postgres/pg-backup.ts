/**
 * PostgreSQL backup and restore via pg_dump / pg_restore.
 *
 * FNXC:PostgresBackup 2026-06-24-21:00:
 * After the SQLite→PostgreSQL cutover, backups are PostgreSQL logical dumps
 * (`pg_dump`) instead of SQLite file copies. This module reworks the
 * `BackupManager` contract for PostgreSQL: it produces restorable dumps and
 * restores them via `pg_restore`, preserving the project + central pairing
 * that the SQLite BackupManager maintained (VAL-REMOVAL-003).
 *
 * The three Fusion databases (project, central, archive) are PostgreSQL
 * schemas within a single cluster. A backup therefore dumps the application
 * schemas (not the whole cluster, which may contain unrelated databases).
 * The project + central pair is preserved as two timestamped dump files in
 * the same backup directory, mirroring the SQLite `fusion-*.db` +
 * `fusion-central-*.db` pairing.
 *
 * The dump format is `--format=custom` (pg_dump's native compressed format)
 * because it supports parallel restore, selective restore, and is restorable
 * via `pg_restore`. This is the standard PostgreSQL backup format.
 *
 * FNXC:PostgresBackup 2026-06-26-15:00 (fix migration-review P0 #5/#6):
 * Security: the connection components (host/port/user/password/dbname) are
 * passed to pg_dump/pg_restore via the libpq environment variables
 * (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE), not as CLI arguments, so the
 * password never appears in the process argument list (visible via `ps`). The
 * PREVIOUS implementation used `PG_CONNECTION_STRING`, which is NOT a libpq
 * variable — pg_dump/pg_restore ignored it and fell back to the libpq defaults
 * (localhost:5432, current OS user). In embedded mode (random high port) the
 * dump/restore silently targeted the wrong server (an empty system default DB
 * or no server at all). Parsing the URL into the real PG* variables fixes both
 * the embedded-mode correctness and the credential-safety contract.
 */

import { execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * FNXC:PostgresBackup 2026-06-24-21:05:
 * The application schemas that constitute a full backup. These mirror the
 * three SQLite databases (project, central, archive) now mapped to PostgreSQL
 * schemas. The project + central pair is the primary backup target; the
 * archive schema is included in the project dump for a complete snapshot.
 */
export const PROJECT_BACKUP_SCHEMAS = ["project", "archive"] as const;
export const CENTRAL_BACKUP_SCHEMAS = ["central"] as const;

/** Result of a single schema-group dump. */
export interface PgDumpResult {
  readonly filename: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

/** Result of a paired backup (project + central). */
export interface PgBackupSelection {
  readonly family: "regular" | "pre-restore";
  readonly stem: string;
  readonly selectedKind: "project" | "central";
  readonly selectedPath: string;
  readonly projectPath: string;
  readonly centralPath: string;
}

export interface PgBackupPair {
  readonly timestamp: string;
  readonly project?: PgDumpResult;
  readonly central?:
    | PgDumpResult
    | { skipped: "disabled" | "missing" };
}

/**
 * Internal mutable variant used during construction (before the pair is
 * frozen as a PgBackupPair return value).
 */
type MutablePgBackupPair = {
  timestamp: string;
  project?: PgDumpResult;
  central?: PgDumpResult | { skipped: "disabled" | "missing" };
};

/** Options for the PostgreSQL backup manager. */
export interface PgBackupOptions {
  readonly backupDir?: string;
  readonly retention?: number;
  readonly includeCentral?: boolean;
  /**
   * FNXC:PostgresBackup 2026-06-26-17:30 (fix migration-review P1 #26):
   * Override the pg_dump binary path (default: `pg_dump` resolved from PATH).
   *
   * REQUIREMENT: pg_dump and pg_restore are NOT bundled with the
   * `embedded-postgres` package, which only ships `initdb`, `pg_ctl`, and the
   * `postgres` server binary. Operators using the embedded backend (the
   * default when DATABASE_URL is unset) MUST have `pg_dump` and `pg_restore`
   * available on PATH for backup/restore to work. On macOS install via
   * `brew install postgresql@15` (or libpq); on Linux use the system postgresql
   * client package; on Windows use the PostgreSQL installer or the
   * `PostgreSQL Binaries` zip. The major version of pg_dump SHOULD match the
   * embedded server major version (15) to avoid format-incompatibility warnings.
   *
   * For a fully self-contained distribution, a future change may bundle the
   * EnterpriseDB / Zonky pg_dump binaries alongside the embedded server; until
   * then, the requirement is documented here and surfaced as a clear error if
   * the binary is missing when a backup is attempted.
   */
  readonly pgDumpPath?: string;
  /**
   * Override the pg_restore binary path (default: `pg_restore` from PATH).
   * See {@link PgBackupOptions.pgDumpPath} for the bundling/availability note.
   */
  readonly pgRestorePath?: string;
  /** Bounded timeout for each pg_dump/pg_restore process. Defaults to 120s. */
  readonly clientTimeoutMs?: number;
  /**
   * FNXC:PostgresBackup 2026-09-04-01:55:
   * An injectable client seam proves timeout and credential redaction behavior
   * without slow wall-clock process fixtures.
   */
  readonly clientExec?: PgClientExec;
}

export type PgClientExec = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; maxBuffer: number; timeout: number },
) => Promise<unknown>;

/**
 * FNXC:PostgresBackup 2026-06-24-21:10:
 * PostgreSQL backup manager. Produces restorable `pg_dump --format=custom`
 * dumps of the application schemas, preserving the project + central pairing.
 * Restore round-trips via `pg_restore` (VAL-REMOVAL-003).
 *
 * FNXC:PostgresBackup 2026-06-26-15:05 (fix migration-review P0 #5/#6):
 * The connection components (host/port/user/password/dbname) are passed via
 * the libpq environment variables PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
 * — never via the non-functional `PG_CONNECTION_STRING` and never as CLI
 * arguments — so the password is not exposed in the process list (VAL-CONN-005)
 * AND pg_dump/pg_restore connect to the correct server (the embedded cluster's
 * random port, not the libpq default localhost:5432).
 */
/*
FNXC:PostgresBackup 2026-07-10:
Review gap: pg_dump/pg_restore are not bundled with the embedded-postgres
package (it ships only initdb/pg_ctl/postgres), so embedded-mode backups
failed with a bare spawn ENOENT unless the operator happened to have libpq
tools on PATH. Best-effort resolution order: PATH name as-is (unchanged
default), then the common Homebrew/postgres.app/system install locations for
the matching major version (15) and its successors. When nothing resolves we
keep the bare name so the eventual error stays actionable ("pg_dump failed:
... ENOENT" + the install guidance in PgBackupOptions.pgDumpPath).
*/
function resolveClientBinary(name: "pg_dump" | "pg_restore"): string {
  const candidates = [
    // Homebrew (Apple Silicon / Intel), matching-major first.
    `/opt/homebrew/opt/postgresql@15/bin/${name}`,
    `/usr/local/opt/postgresql@15/bin/${name}`,
    `/opt/homebrew/opt/libpq/bin/${name}`,
    `/usr/local/opt/libpq/bin/${name}`,
    `/opt/homebrew/opt/postgresql@16/bin/${name}`,
    `/opt/homebrew/opt/postgresql@17/bin/${name}`,
    // Debian/Ubuntu postgresql-client packages.
    `/usr/lib/postgresql/15/bin/${name}`,
    `/usr/lib/postgresql/16/bin/${name}`,
    `/usr/lib/postgresql/17/bin/${name}`,
    // Postgres.app (macOS).
    `/Applications/Postgres.app/Contents/Versions/latest/bin/${name}`,
  ];
  // PATH lookup first: if the plain name resolves, keep it (operator intent).
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (existsSync(join(dir, name))) return name;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

export class PgBackupManager {
  private readonly connectionString: string;
  private readonly fusionDir: string;
  private readonly backupDir: string;
  private readonly retention: number;
  private readonly includeCentral: boolean;
  private readonly pgDumpPath: string;
  private readonly pgRestorePath: string;
  private readonly clientTimeoutMs: number;
  private readonly clientExec: PgClientExec;

  constructor(connectionString: string, fusionDir: string, options?: PgBackupOptions) {
    this.connectionString = connectionString;
    this.fusionDir = fusionDir;
    this.backupDir = options?.backupDir ?? ".fusion/backups";
    this.retention = options?.retention ?? 7;
    this.includeCentral = options?.includeCentral ?? true;
    this.pgDumpPath = options?.pgDumpPath ?? resolveClientBinary("pg_dump");
    this.pgRestorePath = options?.pgRestorePath ?? resolveClientBinary("pg_restore");
    this.clientTimeoutMs = options?.clientTimeoutMs ?? 120_000;
    this.clientExec = options?.clientExec ?? execFileAsync;
  }

  private getBackupDirPath(): string {
    return resolve(this.fusionDir, "..", this.backupDir);
  }

  /**
   * FNXC:PostgresBackup 2026-09-04-01:55:
   * Filename existence checks are a cross-process TOCTOU. A single exclusively
   * created marker is the stem claim; it covers both dump halves atomically.
   */
  private async allocateBackupStem(family: PgBackupFamily): Promise<BackupStemReservation> {
    const initial = currentBackupTimestamp();
    const backupDirPath = this.getBackupDirPath();
    let counter = 0;
    while (true) {
      const stem = counter === 0 ? initial : `${initial}-${counter}`;
      const projectPath = join(backupDirPath, formatBackupFilename("project", family, stem));
      const centralPath = join(backupDirPath, formatBackupFilename("central", family, stem));
      const markerPath = `${projectPath}.reserved`;
      if (existsSync(projectPath) || existsSync(centralPath)) {
        counter += 1;
        continue;
      }
      const nonce = `${process.pid}:${crypto.randomUUID()}`;
      try {
        const handle = await open(markerPath, "wx");
        await handle.writeFile(nonce, "utf8");
        await handle.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          counter += 1;
          continue;
        }
        throw error;
      }
      if (existsSync(projectPath) || existsSync(centralPath)) {
        await this.releaseReservation(markerPath, nonce);
        counter += 1;
        continue;
      }
      return { stem, markerPath, nonce };
    }
  }

  private async assertReservation(markerPath: string, nonce: string): Promise<void> {
    let owner: string;
    try {
      owner = await readFile(markerPath, "utf8");
    } catch {
      throw new Error("Backup stem reservation was lost before dump publication");
    }
    if (owner !== nonce) throw new Error("Backup stem reservation ownership changed before dump publication");
  }

  private async releaseReservation(markerPath: string, nonce: string): Promise<void> {
    try {
      if (await readFile(markerPath, "utf8") === nonce) await unlink(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  resolveBackupSelection(input: string): PgBackupSelection {
    const selectedFilename = basename(input);
    const parsed = parseBackupFilename(selectedFilename);
    if (!parsed) {
      throw new Error(
        `Invalid PostgreSQL backup filename: ${input}. Expected a canonical fusion-*-pg-<timestamp>.dump file.`,
      );
    }
    const selectedPath = selectedFilename === input
      ? join(this.getBackupDirPath(), selectedFilename)
      : resolve(input);
    const directory = dirname(selectedPath);
    return {
      family: parsed.family,
      stem: parsed.stem,
      selectedKind: parsed.kind,
      selectedPath,
      projectPath: join(
        directory,
        formatBackupFilename("project", parsed.family, parsed.stem),
      ),
      centralPath: join(
        directory,
        formatBackupFilename("central", parsed.family, parsed.stem),
      ),
    };
  }

  /**
   * Create a paired backup: project schemas (project + archive) and central
   * schema as two timestamped dump files. Returns the pair info.
   *
   * FNXC:PostgresBackup 2026-06-26-15:10 (fix migration-review P1 #25):
   * If the central dump fails AFTER the project dump succeeded, the orphaned
   * project dump is removed before propagating the error so the backup
   * directory does not accumulate half-pairs. Previously, a central-dump
   * failure left the project `.dump` behind, and `listBackups()` then counted
   * it as a pair (project present, central missing), skewing retention and
   * presenting a misleading "complete" backup. A failed backup now leaves
   * nothing behind.
   */
  async createBackup(): Promise<PgBackupPair> {
    return this.createBackupPair({
      family: "regular",
      includeCentral: this.includeCentral,
      cleanup: true,
    });
  }

  /**
   * Capture the current project/archive and central schemas before a restore.
   * This deliberately skips retention cleanup so a selected source cannot be
   * rotated away and recovery evidence survives every restore outcome.
   */
  async createPreRestoreBackup(): Promise<PgBackupPair> {
    return this.createBackupPair({
      family: "pre-restore",
      includeCentral: true,
      cleanup: false,
    });
  }

  private async createBackupPair(options: {
    family: PgBackupFamily;
    includeCentral: boolean;
    cleanup: boolean;
  }): Promise<PgBackupPair> {
    const backupDirPath = this.getBackupDirPath();
    await mkdir(backupDirPath, { recursive: true });
    const reservation = await this.allocateBackupStem(options.family);
    const projectFilename = formatBackupFilename("project", options.family, reservation.stem);
    const centralFilename = formatBackupFilename("central", options.family, reservation.stem);
    const projectPath = join(backupDirPath, projectFilename);
    const centralPath = join(backupDirPath, centralFilename);
    const projectPartPath = `${projectPath}.part`;
    const centralPartPath = `${centralPath}.part`;
    let publishedProject = false;
    let pair: MutablePgBackupPair | undefined;

    try {
      await this.dumpSchemas(PROJECT_BACKUP_SCHEMAS, projectPartPath);
      const project = await this.publishDump(projectPartPath, projectPath, reservation);
      publishedProject = true;
      pair = {
        timestamp: options.family === "pre-restore" ? `pre-restore-${reservation.stem}` : reservation.stem,
        project,
      };
      if (options.includeCentral) {
        await this.dumpSchemas(CENTRAL_BACKUP_SCHEMAS, centralPartPath);
        pair.central = await this.publishDump(centralPartPath, centralPath, reservation);
      }
    } catch (error) {
      if (publishedProject) await unlink(projectPath).catch(() => undefined);
      throw error;
    } finally {
      await Promise.all([
        unlink(projectPartPath).catch(() => undefined),
        unlink(centralPartPath).catch(() => undefined),
      ]);
      await this.releaseReservation(reservation.markerPath, reservation.nonce);
    }

    /*
     * FNXC:PostgresBackup 2026-09-04-01:55:
     * Project-only backups are regular backups too. Retention runs after this
     * run publishes and releases its claim, while pre-restore evidence never rotates.
     */
    if (options.cleanup) await this.cleanupOldBackups();
    return pair!;
  }

  /**
   * FNXC:PostgresBackup 2026-09-04-01:55:
   * pg_dump writes a private .part path and publication is a rename only after
   * ownership is rechecked, so truncated archives are never restorable.
   */
  private async publishDump(
    partPath: string,
    finalPath: string,
    reservation: BackupStemReservation,
  ): Promise<PgDumpResult> {
    await this.assertReservation(reservation.markerPath, reservation.nonce);
    await rename(partPath, finalPath);
    const stats = await stat(finalPath);
    return {
      filename: basename(finalPath),
      path: finalPath,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * FNXC:PostgresBackup 2026-06-24-21:15:
   * Restore a dump file into the PostgreSQL cluster. By default this drops and
   * recreates the target schemas so the restore is clean (no orphan rows from
   * a partial prior state). The connection string is passed via env var.
   *
   * Warning: restore is destructive — it replaces the target schemas' contents.
   * Callers should create a pre-restore backup first (the CLI layer does this).
   */
  async validateBackup(dumpPath: string): Promise<void> {
    await this.requireBackupFile(dumpPath);
    await this.runPgRestore(["--list", dumpPath]);
  }

  async restoreBackup(dumpPath: string, opts: { clean?: boolean } = {}): Promise<void> {
    await this.requireBackupFile(dumpPath);
    const clean = opts.clean ?? true;
    const args = ["--format=custom", "--no-owner", "--no-privileges"];
    if (clean) args.push("--clean", "--if-exists");
    args.push("--single-transaction", dumpPath);
    await this.runPgRestore(args);
  }

  private async requireBackupFile(dumpPath: string): Promise<void> {
    if (!existsSync(dumpPath)) {
      throw new Error(`Backup file not found: ${dumpPath}`);
    }
    const stats = await stat(dumpPath);
    if (!stats.isFile()) throw new Error(`Backup path is not a file: ${dumpPath}`);
  }

  /**
   * FNXC:PostgresBackup 2026-06-24-21:20:
   * List all backup pairs in the backup directory, newest first. A pair is a
   * project dump and its matching central dump (by timestamp).
   */
  async listBackups(): Promise<PgBackupPair[]> {
    const backupDirPath = this.getBackupDirPath();
    if (!existsSync(backupDirPath)) return [];

    const byStem = new Map<string, MutablePgBackupPair>();
    for (const filename of await readdir(backupDirPath)) {
      const parsed = parseBackupFilename(filename);
      if (!parsed) continue;

      const path = join(backupDirPath, filename);
      const stats = await stat(path);
      if (!stats.isFile()) continue;

      const key = `${parsed.family}:${parsed.stem}`;
      const pair = byStem.get(key) ?? {
        timestamp: parsed.family === "pre-restore" ? `pre-restore-${parsed.stem}` : parsed.stem,
      };
      const result: PgDumpResult = {
        filename,
        path,
        sizeBytes: stats.size,
        createdAt: stats.mtime.toISOString(),
      };
      if (parsed.kind === "project") pair.project = result;
      else pair.central = result;
      byStem.set(key, pair);
    }

    return [...byStem.values()].sort((left, right) => {
      const leftCreated = latestPairCreatedAt(left);
      const rightCreated = latestPairCreatedAt(right);
      return rightCreated.localeCompare(leftCreated) || right.timestamp.localeCompare(left.timestamp);
    });
  }

  /**
   * FNXC:PostgresBackup 2026-06-24-21:25:
   * Delete backups older than the retention window. Keeps the newest
   * `retention` pairs. A pair is counted as one regardless of whether the
   * central half succeeded.
   */
  async cleanupOldBackups(): Promise<{ deleted: string[] }> {
    const reservedStems = await this.sweepAndCollectLiveReservations();
    const backups = (await this.listBackups()).filter((pair) => {
      const family: PgBackupFamily = pair.timestamp.startsWith("pre-restore-") ? "pre-restore" : "regular";
      const stem = pair.timestamp.replace(/^pre-restore-/, "");
      return !reservedStems.has(`${family}:${stem}`);
    });
    if (backups.length <= this.retention) return { deleted: [] };

    const deleted: string[] = [];
    for (const pair of backups.slice(this.retention)) {
      if (pair.project && await unlinkIfPresent(pair.project.path)) deleted.push(pair.project.filename);
      if (pair.central && "path" in pair.central && await unlinkIfPresent(pair.central.path)) {
        deleted.push(pair.central.filename);
      }
    }
    return { deleted };
  }

  /**
   * FNXC:PostgresBackup 2026-09-04-01:55:
   * Cleanup can run in another process while pg_dump is active. Live claims do
   * not count toward retention or deletion; only abandoned claims age out.
   */
  private async sweepAndCollectLiveReservations(): Promise<Set<string>> {
    const backupDirPath = this.getBackupDirPath();
    if (!existsSync(backupDirPath)) return new Set();
    const live = new Set<string>();
    const staleAfterMs = Math.max(MIN_ABANDONED_RESERVATION_MS, this.clientTimeoutMs * 2);
    for (const filename of await readdir(backupDirPath)) {
      if (!filename.endsWith(".reserved")) continue;
      const dumpFilename = filename.slice(0, -".reserved".length);
      const parsed = parseBackupFilename(dumpFilename);
      if (!parsed || parsed.kind !== "project") continue;
      const markerPath = join(backupDirPath, filename);
      const markerStats = await stat(markerPath).catch(() => undefined);
      if (!markerStats) continue;
      if (Date.now() - markerStats.mtimeMs < staleAfterMs) {
        live.add(`${parsed.family}:${parsed.stem}`);
        continue;
      }
      const projectPartPath = `${join(backupDirPath, dumpFilename)}.part`;
      const centralPartPath = `${join(backupDirPath, formatBackupFilename("central", parsed.family, parsed.stem))}.part`;
      await Promise.all([
        unlink(markerPath).catch(() => undefined),
        unlink(projectPartPath).catch(() => undefined),
        unlink(centralPartPath).catch(() => undefined),
      ]);
    }
    return live;
  }

  /**
   * Run pg_dump for the given schemas into the target path. The connection
   * string is passed via PG_CONNECTION_STRING env var (credential safety).
   */
  private async dumpSchemas(schemas: readonly string[], outputPath: string): Promise<void> {
    const args = [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      ...schemas.flatMap((schema) => ["--schema", schema]),
      "--file",
      outputPath,
    ];
    await this.runPgDump(args);
    await stat(outputPath);
  }

  /**
   * FNXC:PostgresBackup 2026-06-24-21:30 (revised 2026-06-26, fix migration-review P0 #5/#6):
   * Execute pg_dump with the connection components passed via the libpq
   * environment variables PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE. The
   * password (and any other credential) is NEVER passed as a CLI argument —
   * only via env vars — so it does not appear in the process argument list
   * visible via `ps` (VAL-CONN-005). Using the real libpq PG* variables (not
   * the non-functional `PG_CONNECTION_STRING`) is what makes pg_dump connect
   * to the correct embedded-cluster port instead of the libpq default
   * localhost:5432.
   */
  private async runPgDump(args: string[]): Promise<void> {
    try {
      await this.clientExec(this.pgDumpPath, args, {
        env: this.buildLibpqEnv(),
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.clientTimeoutMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`pg_dump failed: ${redactClientError(msg, this.connectionString)}`);
    }
  }

  private async runPgRestore(args: string[]): Promise<void> {
    try {
      await this.clientExec(this.pgRestorePath, args, {
        env: this.buildLibpqEnv(),
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.clientTimeoutMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`pg_restore failed: ${redactClientError(msg, this.connectionString)}`);
    }
  }

  /**
   * FNXC:PostgresBackup 2026-06-26-15:15 (fix migration-review P0 #5/#6):
   * Build a libpq-compatible environment for pg_dump/pg_restore by parsing the
   * configured connection URL into its PGHOST/PGPORT/PGUSER/PGPASSWORD/
   * PGDATABASE components and merging them onto the existing process.env.
   *
   * libpq reads these variables directly (no `--dbname`/`PG_CONNECTION_STRING`
   * needed). This is the only correct way to point pg_dump/pg_restore at the
   * embedded cluster's random port without putting the password on the argv.
   * The existing process.env is preserved so other libpq variables (e.g.
   * PGSSLMODE) the operator may have set are inherited; the parsed URL
   * components take precedence.
   *
   * If the URL cannot be parsed, we fall back to PGDATABASE set from the raw
   * string so the operator still gets a clear "could not connect" error from
   * pg_dump rather than the silent wrong-server behavior of the old code.
   */
  private buildLibpqEnv(): NodeJS.ProcessEnv {
    const parsed = parsePgUrl(this.connectionString);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (parsed.host) env.PGHOST = parsed.host;
    if (parsed.port !== undefined) env.PGPORT = String(parsed.port);
    if (parsed.user) env.PGUSER = parsed.user;
    if (parsed.password !== undefined) env.PGPASSWORD = parsed.password;
    if (parsed.dbname) env.PGDATABASE = parsed.dbname;
    return env;
  }
}

const MIN_ABANDONED_RESERVATION_MS = 60_000;

interface BackupStemReservation {
  stem: string;
  markerPath: string;
  nonce: string;
}

async function unlinkIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

type PgBackupKind = "project" | "central";
type PgBackupFamily = "regular" | "pre-restore";

interface ParsedBackupFilename {
  kind: PgBackupKind;
  family: PgBackupFamily;
  stem: string;
}

function formatBackupFilename(
  kind: PgBackupKind,
  family: PgBackupFamily,
  stem: string,
): string {
  const central = kind === "central" ? "central-" : "";
  const preRestore = family === "pre-restore" ? "pre-restore-" : "";
  return `fusion-${central}${preRestore}pg-${stem}.dump`;
}

function parseBackupFilename(filename: string): ParsedBackupFilename | null {
  const match = filename.match(
    /^fusion-(central-)?(pre-restore-)?pg-((?:\d{8}|\d{4}-\d{2}-\d{2})-\d{6}(?:-\d+)?)\.dump$/,
  );
  if (!match) return null;
  return {
    kind: match[1] ? "central" : "project",
    family: match[2] ? "pre-restore" : "regular",
    stem: match[3],
  };
}

function latestPairCreatedAt(pair: MutablePgBackupPair): string {
  const central = pair.central && "createdAt" in pair.central ? pair.central.createdAt : "";
  return pair.project?.createdAt && pair.project.createdAt > central
    ? pair.project.createdAt
    : central;
}

/** Generate a production backup timestamp (YYYYMMDD-HHMMSS). */
function currentBackupTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Redact any connection-string password that may appear in a pg_dump/pg_restore
 * error message. Defense-in-depth for VAL-CONN-005.
 */
function redactClientError(msg: string, connectionString: string): string {
  let redacted = msg.replace(/(postgresql?:\/\/[^:]+:)[^@]+@/g, "$1***@");
  const password = parsePgUrl(connectionString).password;
  if (password) redacted = redacted.split(password).join("***");
  return redacted;
}

/**
 * Parsed components of a `postgresql://` (or libpq keyword/value) connection
 * string, as required by the libpq PG* environment variables.
 */
interface ParsedPgUrl {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  dbname?: string;
}

/**
 * FNXC:PostgresBackup 2026-06-26-15:20 (fix migration-review P0 #5/#6):
 * Parse a Fusion connection string into the libpq PG* variable components.
 *
 * Supports both shapes the connection layer produces:
 *   1. URL form: `postgresql://user:password@host:port/dbname?params`
 *   2. libpq keyword/value form: `host=h port=5432 user=u password=p dbname=d`
 *
 * Defaults follow libpq conventions when a component is absent:
 *   - host: "localhost"
 *   - port: 5432
 *   - user: current OS user (left undefined so libpq resolves it)
 *   - password: undefined (no password set)
 *   - dbname: undefined (libpq falls back to the user name)
 *
 * Query parameters that map to libpq variables (sslmode, sslrootcert, etc.)
 * are intentionally NOT translated here — pg_dump/pg_restore against the
 * embedded cluster (localhost, random port, password auth) does not need TLS,
 * and translating arbitrary query params risks mis-setting libpq. Operators
 * pointing at an external TLS server can still set PGSSLMODE etc. in the
 * surrounding environment; those are preserved by the spread in buildLibpqEnv.
 */
export function parsePgUrl(connStr: string): ParsedPgUrl {
  const result: ParsedPgUrl = {};
  const trimmed = connStr.trim();

  // URL form.
  if (/^(postgres|postgresql):\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      result.host = url.hostname || undefined;
      if (url.port) {
        const port = Number(url.port);
        if (Number.isFinite(port) && port > 0) result.port = port;
      }
      result.user = url.username ? decodeURIComponent(url.username) : undefined;
      result.password = url.password ? decodeURIComponent(url.password) : undefined;
      // Strip a leading slash; an empty path means "no dbname".
      const path = url.pathname.replace(/^\/+/, "");
      result.dbname = path ? decodeURIComponent(path) : undefined;
    } catch {
      // Malformed URL — leave result empty so the caller surfaces a connect error.
    }
    return result;
  }

  // libpq keyword/value form: `host=h port=5432 user=u password=p dbname=d`.
  // Values may be quoted ("...", '...') or bare.
  const kvRe = /([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = kvRe.exec(trimmed)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    switch (key) {
      case "host":
        result.host = value;
        break;
      case "port": {
        const port = Number(value);
        if (Number.isFinite(port) && port > 0) result.port = port;
        break;
      }
      case "user":
        result.user = value;
        break;
      case "password":
        result.password = value;
        break;
      case "dbname":
        result.dbname = value;
        break;
      default:
        break;
    }
  }
  return result;
}

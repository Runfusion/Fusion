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
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
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
}

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

  constructor(connectionString: string, fusionDir: string, options?: PgBackupOptions) {
    this.connectionString = connectionString;
    this.fusionDir = fusionDir;
    this.backupDir = options?.backupDir ?? ".fusion/backups";
    this.retention = options?.retention ?? 7;
    this.includeCentral = options?.includeCentral ?? true;
    this.pgDumpPath = options?.pgDumpPath ?? resolveClientBinary("pg_dump");
    this.pgRestorePath = options?.pgRestorePath ?? resolveClientBinary("pg_restore");
  }

  private getBackupDirPath(): string {
    return join(this.fusionDir, "..", this.backupDir);
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
    const backupDirPath = this.getBackupDirPath();
    await mkdir(backupDirPath, { recursive: true });

    const timestamp = currentBackupTimestamp();
    const projectFilename = `fusion-pg-${timestamp}.dump`;
    const projectPath = join(backupDirPath, projectFilename);

    const projectResult = await this.dumpSchemas(
      PROJECT_BACKUP_SCHEMAS,
      projectPath,
      projectFilename,
    );

    const pair: MutablePgBackupPair = { timestamp, project: projectResult };

    if (!this.includeCentral) {
      return pair;
    }

    const centralFilename = `fusion-central-pg-${timestamp}.dump`;
    const centralPath = join(backupDirPath, centralFilename);
    try {
      const centralResult = await this.dumpSchemas(
        CENTRAL_BACKUP_SCHEMAS,
        centralPath,
        centralFilename,
      );
      pair.central = centralResult;
    } catch (err) {
      // FNXC:PostgresBackup 2026-06-26-15:10:
      // Central dump failed. Remove the orphaned project dump so the backup
      // directory does not hold a half-pair that `listBackups()` would later
      // count as a complete pair. The error propagates to the caller.
      await unlink(projectPath).catch(() => {
        // best-effort cleanup; the original error is the one to surface.
      });
      throw err;
    }

    await this.cleanupOldBackups();
    return pair;
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
  async restoreBackup(dumpPath: string, opts: { clean?: boolean } = {}): Promise<void> {
    if (!existsSync(dumpPath)) {
      throw new Error(`Backup file not found: ${dumpPath}`);
    }
    const clean = opts.clean ?? true;
    const args = ["--format=custom"];
    if (clean) {
      args.push("--clean", "--if-exists");
    }
    args.push(dumpPath);

    await this.runPgRestore(args);
  }

  /**
   * FNXC:PostgresBackup 2026-06-24-21:20:
   * List all backup pairs in the backup directory, newest first. A pair is a
   * project dump and its matching central dump (by timestamp).
   */
  async listBackups(): Promise<PgBackupPair[]> {
    const backupDirPath = this.getBackupDirPath();
    if (!existsSync(backupDirPath)) return [];

    const entries = await readdir(backupDirPath);
    const projectDumps = entries.filter((f) => /^fusion-pg-.*\.dump$/.test(f));
    const centralDumps = entries.filter((f) => /^fusion-central-pg-.*\.dump$/.test(f));

    const byTimestamp = new Map<string, MutablePgBackupPair>();

    for (const filename of projectDumps) {
      const timestamp = extractTimestamp(filename, "fusion-pg-", ".dump");
      if (!timestamp) continue;
      const path = join(backupDirPath, filename);
      const stats = await stat(path);
      byTimestamp.set(timestamp, {
        timestamp,
        project: {
          filename,
          path,
          sizeBytes: stats.size,
          createdAt: stats.mtime.toISOString(),
        },
      });
    }

    for (const filename of centralDumps) {
      const timestamp = extractTimestamp(filename, "fusion-central-pg-", ".dump");
      if (!timestamp) continue;
      const path = join(backupDirPath, filename);
      const stats = await stat(path);
      const existing = byTimestamp.get(timestamp) ?? { timestamp };
      existing.central = {
        filename,
        path,
        sizeBytes: stats.size,
        createdAt: stats.mtime.toISOString(),
      };
      byTimestamp.set(timestamp, existing);
    }

    return [...byTimestamp.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /**
   * FNXC:PostgresBackup 2026-06-24-21:25:
   * Delete backups older than the retention window. Keeps the newest
   * `retention` pairs. A pair is counted as one regardless of whether the
   * central half succeeded.
   */
  async cleanupOldBackups(): Promise<{ deleted: string[] }> {
    const backups = await this.listBackups();
    if (backups.length <= this.retention) return { deleted: [] };

    const toDelete = backups.slice(this.retention);
    const deleted: string[] = [];
    for (const pair of toDelete) {
      if (pair.project) {
        await unlink(pair.project.path).catch(() => {});
        deleted.push(pair.project.filename);
      }
      if (pair.central && "path" in pair.central) {
        await unlink(pair.central.path).catch(() => {});
        deleted.push(pair.central.filename);
      }
    }
    return { deleted };
  }

  /**
   * Run pg_dump for the given schemas into the target path. The connection
   * string is passed via PG_CONNECTION_STRING env var (credential safety).
   */
  private async dumpSchemas(
    schemas: readonly string[],
    outputPath: string,
    _filename: string,
  ): Promise<PgDumpResult> {
    const args = [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      ...schemas.flatMap((s) => ["--schema", s]),
      // Output to file (not stdout) so the dump lands directly on disk.
      "--file",
      outputPath,
    ];

    await this.runPgDump(args);

    const stats = await stat(outputPath);
    return {
      filename: outputPath.split("/").pop() ?? outputPath,
      path: outputPath,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
    };
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
      await execFileAsync(this.pgDumpPath, args, {
        env: this.buildLibpqEnv(),
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`pg_dump failed: ${redactConnStringInMessage(msg)}`);
    }
  }

  private async runPgRestore(args: string[]): Promise<void> {
    try {
      await execFileAsync(this.pgRestorePath, args, {
        env: this.buildLibpqEnv(),
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`pg_restore failed: ${redactConnStringInMessage(msg)}`);
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

/**
 * Generate a backup timestamp matching the SQLite backup naming convention
 * (YYYYMMDD-HHMMSS), with collision avoidance handled by the caller.
 */
function currentBackupTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function extractTimestamp(filename: string, prefix: string, suffix: string): string | null {
  if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) return null;
  return filename.slice(prefix.length, filename.length - suffix.length);
}

/**
 * Redact any connection-string password that may appear in a pg_dump/pg_restore
 * error message. Defense-in-depth for VAL-CONN-005.
 */
function redactConnStringInMessage(msg: string): string {
  return msg.replace(/(postgresql?:\/\/[^:]+:)[^@]+@/g, "$1***@");
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

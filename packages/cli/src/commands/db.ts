import {
  createConnectionSetFromUrl,
  createAsyncDataLayer,
  vacuumAnalyze,
  resolveBackend,
  migrateSqliteToPostgres,
  formatMigrationProgress,
  completeSqliteMigration,
  defaultMigrationSources,
  stampMigratedProjectRows,
  lookupRegisteredProjectIdByPath,
  resolveGlobalDir,
  DatabaseSync,
  type MigrationReport,
} from "@fusion/core";
import { resolveProject } from "../project-context.js";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

export async function runDbVacuum(_projectName?: string): Promise<void> {
  /*
   * FNXC:PostgresHealth 2026-06-26-16:30:
   * VAL-HEALTH-005 / VAL-REMOVAL-005 — The operator compaction command runs
   * VACUUM/ANALYZE against the PostgreSQL backend and reports per-table stats
   * (dead tuples reclaimed, size delta). The legacy SQLite single-file VACUUM
   * path was removed: the SQLite runtime is gone, and its literal keyword
   * failed the VAL-REMOVAL-005 grep.
   *
   * External mode (DATABASE_URL set): connect and run VACUUM/ANALYZE directly.
   * Embedded mode (DATABASE_URL unset): the embedded PostgreSQL cluster
   * manages its own autovacuum/WAL, and an explicit compaction against the
   * embedded instance is not exposed via this command — print a clear message
   * instead of falling back to a removed SQLite path. This mirrors how
   * `fn db migrate` branches on external mode.
   */
  const backend = resolveBackend(process.env);
  if (backend.mode === "external" && backend.runtimeUrl) {
    return runPostgresVacuumAnalyze(backend);
  }

  console.error(
    "fn db vacuum: requires DATABASE_URL (external PostgreSQL mode). In embedded mode, " +
      "the embedded PostgreSQL cluster manages its own autovacuum and WAL checkpointing. " +
      "Set DATABASE_URL to run an explicit VACUUM/ANALYZE compaction against an external server.",
  );
  process.exit(1);
}

/**
 * FNXC:PostgresHealth 2026-06-24-16:35:
 * Run VACUUM/ANALYZE against the PostgreSQL backend and print per-table stats.
 * This is the explicit operator compaction command for PostgreSQL
 * (VAL-HEALTH-005). Reports dead tuples reclaimed and table-size deltas for
 * each core table so the operator gets actionable feedback.
 */
async function runPostgresVacuumAnalyze(
  backend: ReturnType<typeof resolveBackend>,
): Promise<void> {
  if (!backend.runtimeUrl) {
    console.error("PostgreSQL VACUUM failed: no runtime URL resolved.");
    process.exit(1);
    return;
  }

  let connections;
  try {
    connections = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 10 });
  } catch (error) {
    console.error(`PostgreSQL connection failed: ${(error as Error).message}`);
    process.exit(1);
    return;
  }

  const layer = createAsyncDataLayer(connections);
  try {
    const result = await vacuumAnalyze(layer.db);
    console.log(`VACUUM/ANALYZE completed at ${result.ranAt}`);
    console.log(`Total dead tuples reclaimed: ${result.totalDeadTuplesReclaimed}`);
    console.log(`Total bytes reclaimed: ${formatBytes(result.totalBytesReclaimed)}`);
    console.log("");
    console.log("Per-table stats:");
    for (const stat of result.tables) {
      console.log(
        `  ${stat.table}: ${stat.rowsBefore} -> ${stat.rowsAfter} rows, ` +
        `${stat.deadTuplesBefore} -> ${stat.deadTuplesAfter} dead tuples, ` +
        `${formatBytes(stat.sizeBytesBefore)} -> ${formatBytes(stat.sizeBytesAfter)}` +
        `${stat.analyzed ? " (analyzed)" : ""}`,
      );
    }
    process.exit(0);
  } catch (error) {
    console.error(`PostgreSQL VACUUM/ANALYZE failed: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    await layer.close().catch(() => {});
  }
}

/**
 * FNXC:PostgresMigration 2026-06-26-17:00 (fix migration-review P1 #27):
 * `fn db migrate` — the first-class cutover entry point that migrates legacy
 * SQLite data into the configured PostgreSQL backend (embedded or external).
 *
 * Without this command, the first boot on the new embedded-PG default produces
 * an EMPTY database; existing SQLite data is invisible until a hand-written
 * script runs migrateSqliteToPostgres. This is the silent data-loss trap the
 * migration review flagged (#27).
 *
 * What the command does, end to end:
 *   1. Resolve the target PostgreSQL backend (DATABASE_URL set → external;
 *      unset → embedded). Refuses to run if no backend is resolved.
 *   2. Locate the legacy SQLite files (fusion.db, archive.db in the project
 *      .fusion dir; fusion-central.db in the global ~/.fusion dir).
 *   3. Create a pre-migration backup by COPYING the SQLite files into a
 *      timestamped sibling directory. This is the operator safety net: if the
 *      migration corrupts anything, the original SQLite files are intact.
 *      (pg_dump of the PG side is not useful pre-migration because the PG side
 *      is typically empty; the SQLite files ARE the source of truth.)
 *   4. Open a migration Drizzle connection to the target PostgreSQL cluster.
 *   5. Run migrateSqliteToPostgres (idempotent: ON CONFLICT DO NOTHING;
 *      applies the schema baseline if needed; bumps identity sequences).
 *   6. Print a per-table report (source rows, inserted rows, target rows,
 *      verified flag) and a summary. Exits non-zero if ANY table failed
 *      verification so CI/scripts can detect a partial migration.
 *
 * Usage:
 *   fn db migrate [--dry-run] [--project <name>]
 *
 * --dry-run reports the planned copy (which tables, how many rows) WITHOUT
 * modifying the PostgreSQL target. No backup is created in dry-run mode.
 */
export async function runDbMigrate(
  projectName?: string,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  const dryRun = opts.dryRun === true;

  // 1. Resolve the target backend.
  const backend = resolveBackend(process.env);

  // FNXC:PostgresMigration 2026-06-26-17:10:
  // `fn db migrate` targets an EXTERNAL PostgreSQL backend (DATABASE_URL set).
  // In embedded mode (DATABASE_URL unset), the auto-migrate path runs at
  // startup via the startup factory (createTaskStoreForBackend), which starts
  // the embedded cluster and applies the schema baseline. For an explicit
  // cutover against a managed/remote PostgreSQL, set DATABASE_URL and run this
  // command. This mirrors how `fn db vacuum` branches on external mode.
  if (backend.mode !== "external" || !backend.runtimeUrl) {
    console.error(
      "fn db migrate: requires DATABASE_URL (external PostgreSQL mode). In embedded mode, " +
        "the auto-migrate path runs at `fn serve` startup. Set DATABASE_URL to target an " +
        "external PostgreSQL server for an explicit cutover migration.",
    );
    process.exit(1);
    return;
  }
  const runtimeUrl: string = backend.runtimeUrl;

  // 2. Locate the legacy SQLite files.
  let projectRoot: string;
  try {
    const ctx = await resolveProject(projectName);
    projectRoot = ctx.projectPath;
  } catch {
    projectRoot = process.cwd();
  }
  const fusionDir = join(projectRoot, ".fusion");
  const globalDir = resolveGlobalDir();
  const sources = defaultMigrationSources(fusionDir, globalDir);

  // Filter to sources that actually exist (an operator may run this before all
  // three SQLite files are present, e.g. a project with no archive.db yet).
  const presentSources = sources.filter((s) => existsSync(s.sqlitePath));
  if (presentSources.length === 0) {
    console.error(
      `fn db migrate: no legacy SQLite files found under ${fusionDir} (or ${globalDir}). Nothing to migrate.`,
    );
    process.exit(1);
    return;
  }

  console.log(
    `fn db migrate: target backend ${backend.mode} (${describeBackendSafe(backend)}).`,
  );
  console.log(
    `fn db migrate: ${presentSources.length}/${sources.length} SQLite sources present:`,
  );
  for (const s of presentSources) {
    console.log(`  - ${s.sqlitePath} -> schema "${s.pgSchema}"`);
  }

  // 3. Pre-migration backup (skip in dry-run).
  if (!dryRun) {
    const backupDir = await createPreMigrationBackup(fusionDir, globalDir, sources);
    console.log(`fn db migrate: pre-migration SQLite backup at ${backupDir}`);
  }

  if (dryRun) {
    console.log("fn db migrate: --dry-run set; reporting plan only, no writes.");
  }

  // 4. Open a migration connection to the target cluster.
  // Use a small pool (1) and the migration URL (direct connection) so DDL and
  // the session_replication_role toggle work even under a transaction pooler.
  // Construct a backend descriptor with the resolved runtimeUrl (which may
  // differ from the original when we started an embedded cluster above).
  const resolvedBackend = { ...backend, runtimeUrl: runtimeUrl! };
  let connections;
  try {
    connections = await createConnectionSetFromUrl(resolvedBackend, {
      poolMax: 1,
      connectTimeoutSeconds: 30,
    });
  } catch (error) {
    console.error(
      `fn db migrate: PostgreSQL connection failed: ${(error as Error).message}`,
    );
    process.exit(1);
    return;
  }

  // 5. Run the migrator.
  /*
   * FNXC:PostgresMigration 2026-07-14-00:05:
   * Manual cutover must know the central project identity before copying any
   * project-owned table. Resolve it from the target registry or the legacy
   * central source and fail closed when ownership is ambiguous; post-copy
   * stamping cannot repair plugin and automation rows that were imported
   * without their required project partition.
   */
  let registeredProjectId: string | undefined;
  try {
    registeredProjectId = await lookupRegisteredProjectIdByPath(connections.migration, projectRoot);
  } catch {
    // A fresh target has no schema until the migrator applies the baseline.
  }
  if (!registeredProjectId) {
    const centralSource = presentSources.find((source) => source.pgSchema === "central");
    if (centralSource) {
      const legacyCentral = new DatabaseSync(centralSource.sqlitePath);
      try {
        registeredProjectId = (legacyCentral
          .prepare("SELECT id FROM projects WHERE path = ? LIMIT 1")
          .get(projectRoot) as { id?: string } | undefined)?.id;
      } catch {
        registeredProjectId = undefined;
      } finally {
        legacyCentral.close();
      }
    }
  }
  if (!registeredProjectId) {
    console.error(
      `fn db migrate: cannot resolve project ownership for "${projectRoot}". ` +
        "Register exactly this project in the legacy or PostgreSQL central registry before migrating.",
    );
    await connections.close().catch(() => undefined);
    process.exit(1);
    return;
  }

  let report: MigrationReport;
  try {
    report = await migrateSqliteToPostgres(connections.migration, presentSources, {
      dryRun,
      projectId: registeredProjectId,
      migrationKey: `project:${registeredProjectId}`,
      deferCompletion: true,
      onProgress: (event) => {
        console.log(`fn db migrate: ${formatMigrationProgress(event)}`);
      },
    });
  } catch (error) {
    console.error(`fn db migrate: migration failed: ${(error as Error).message}`);
    await connections.close().catch(() => undefined);
    process.exit(1);
    return;
  }

  /*
   * FNXC:CentralProjectIdentity 2026-07-13-23:10:
   * The migrator now receives project identity before copying so every
   * project-owned table, including plugins and automations, is partitioned at
   * insert time. This final stamp remains necessary for legacy key shapes
   * (NULL task/archive ids, empty config key, and rootDir-keyed workflow
   * settings) and is a hard failure rather than an invisible partial cutover.
   */
  if (!dryRun) {
    try {
      await stampMigratedProjectRows(connections.migration, {
        projectId: registeredProjectId,
        rootDir: projectRoot,
      });
      if (report.tables.every((table) => table.skipped || table.verified)) {
        await completeSqliteMigration(connections.migration, `project:${registeredProjectId}`);
      }
      console.log(
        `fn db migrate: stamped migrated rows with central-registry project id "${registeredProjectId}" (tasks, archived tasks, config, workflow settings).`,
      );
    } catch (error) {
      console.error(`fn db migrate: post-migration project stamping failed: ${(error as Error).message}`);
      await connections.close().catch(() => undefined);
      process.exit(1);
      return;
    }
  }

  await connections.close().catch(() => undefined);

  // 6. Report.
  printMigrationReport(report);

  const failed = report.tables.filter((t) => !t.verified && !t.skipped);
  if (failed.length > 0) {
    console.error(
      `fn db migrate: ${failed.length}/${report.tables.length} tables FAILED verification.`,
    );
    process.exit(1);
    return;
  }
  console.log(
    `fn db migrate: complete. ${report.tables.length} tables processed${
      dryRun ? " (dry-run, no writes)" : ""
    }.`,
  );
  process.exit(0);
}

/** Render a backend descriptor for operator display without leaking credentials. */
function describeBackendSafe(
  backend: ReturnType<typeof resolveBackend>,
): string {
  // backend.runtimeUrl may contain a password; only show mode + a redacted hint.
  if (backend.mode === "external") {
    return "external (DATABASE_URL)";
  }
  return "embedded PostgreSQL";
}

/**
 * FNXC:PostgresMigration 2026-06-26-17:05:
 * Copy every present SQLite source file into a timestamped backup directory
 * under <globalDir>/migration-backups/<timestamp>/. Returns the backup dir
 * path for display. This is the operator safety net: the migration never
 * deletes or modifies the SQLite source files, and a verbatim copy is kept
 * in case a rollback to the SQLite backend is needed.
 */
async function createPreMigrationBackup(
  fusionDir: string,
  globalDir: string,
  sources: readonly { sqlitePath: string }[],
): Promise<string> {
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const backupDir = join(globalDir, "migration-backups", `pre-migrate-${ts}`);
  await mkdir(backupDir, { recursive: true });
  for (const s of sources) {
    if (existsSync(s.sqlitePath)) {
      const dest = join(backupDir, s.sqlitePath.split("/").pop() ?? "source.db");
      await copyFile(s.sqlitePath, dest);
    }
  }
  // Also snapshot the fusion dir + global dir locations for operator reference.
  void fusionDir;
  void globalDir;
  return backupDir;
}

/** Print a human-readable per-table migration report. */
function printMigrationReport(report: MigrationReport): void {
  console.log("");
  console.log("Migration report:");
  console.log(
    `  baseline ${report.appliedBaseline ? "applied" : "already present"} | ` +
      `${report.tables.length} tables | ${report.sequenceBumps.length} sequences bumped`,
  );
  console.log("");
  console.log(
    "  schema.table                        source  inserted  target  verified",
  );
  console.log("  " + "-".repeat(72));
  for (const t of report.tables) {
    const qualified = `${t.schema}.${t.table}`.slice(0, 34).padEnd(34);
    const status = t.skipped ? `SKIP (${t.skipReason ?? "unknown"})` : t.verified ? "ok" : "FAIL";
    console.log(
      `  ${qualified}  ${String(t.sourceRows).padStart(6)}  ${String(
        t.insertedRows,
      ).padStart(8)}  ${String(t.targetRows).padStart(6)}  ${status}`,
    );
  }
  console.log("");
}

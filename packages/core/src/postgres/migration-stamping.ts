/**
 * FNXC:CentralProjectIdentity 2026-07-13-23:10:
 * Post-migration project-partition stamping, extracted from the startup-factory
 * first-boot auto-migration (Step 5.5) so it can be shared with the manual
 * `fn db migrate` cutover command.
 *
 * The SQLite→PostgreSQL migrator (sqlite-migrator.ts) is partition-unaware: it
 * copies legacy rows verbatim, so migrated rows land with NULL project_id
 * (tasks/archived_tasks), a legacy singleton config key ('' — SQLite-parity
 * DEFAULT), and workflow-settings/prompt-override rows keyed by the legacy
 * rootDir path string (or a pre-isolation identity id) instead of the
 * central-registry project id the runtime now scopes every read/write by. Every
 * project-bound reader (engine InProcessRuntime, dashboard
 * project-store-resolver, configScope, workflow-settings resolver) filters those
 * rows out, so the board/settings/workflow surfaces show empty right after a
 * "successful" migration. This helper re-keys the just-migrated rows to the
 * booting project's central-registry id, closing that silent-invisible-data gap
 * on BOTH cutover paths.
 */

import { sql } from "drizzle-orm";
import { acquireSqliteMigrationStateLock } from "./advisory-locks.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/** The Drizzle instance type startup-factory uses for its `connections.migration`. */
type MigrationDb = PostgresJsDatabase<Record<string, never>>;
type MigrationTransaction = Parameters<Parameters<MigrationDb["transaction"]>[0]>[0];

/** Inputs for stamping migrated rows with a project partition key. */
export interface StampMigratedProjectRowsInput {
  /**
   * The central-registry project id every migrated row must be re-keyed to.
   * Resolved by the caller (options.projectId, or a path lookup against
   * central.projects).
   */
  readonly projectId: string;
  /**
   * The project rootDir path. Legacy/migrated workflow_settings and
   * workflow_prompt_overrides rows are keyed by this absolute path string (the
   * pre-isolation key), so re-keying them requires the rootDir as the match
   * predicate.
   */
  readonly rootDir: string;
}

/** Result of a stamping pass. */
export interface StampMigratedProjectRowsResult {
  /** True when the pass ran (a non-empty projectId was supplied). */
  readonly stamped: boolean;
}

/**
 * FNXC:ProjectIdentityPromotion 2026-07-14-14:08:
 * An unregistered project first runs under a stable path-derived partition. If
 * central registration later assigns its canonical ID, atomically promote all
 * project and archive rows plus migration bookkeeping so the next boot cannot
 * strand the project in the fallback partition or repeat its SQLite cutover.
 */
export async function rekeyFallbackProjectPartition(
  db: MigrationDb,
  fallbackProjectId: string,
  registeredProjectId: string,
): Promise<boolean> {
  if (!fallbackProjectId || fallbackProjectId === registeredProjectId) return false;

  return db.transaction(async (tx) => {
    await acquireSqliteMigrationStateLock(tx);
    const tables = (await tx.execute(sql`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'project' AND column_name = 'project_id'
      ORDER BY table_name
    `)) as unknown as Array<{ table_name: string }>;
    /*
    FNXC:ProjectIdentityPromotion 2026-07-14-18:58:
    Fallback ownership can exist only in satellite tables such as agents, reports, or mission state. Inspect every project-owned table before deciding promotion is a no-op; task/archive-only detection stranded those partitions after central registration.
    */
    let ownsProjectRows = false;
    for (const { table_name: tableName } of tables) {
      const rows = (await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM ${sql.identifier("project")}.${sql.identifier(tableName)}
          WHERE project_id = ${fallbackProjectId}
        ) AS found
      `)) as unknown as Array<{ found: boolean }>;
      if (rows[0]?.found) {
        ownsProjectRows = true;
        break;
      }
    }
    if (!ownsProjectRows) {
      const rows = (await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM archive.archived_tasks WHERE project_id = ${fallbackProjectId}
        ) AS found
      `)) as unknown as Array<{ found: boolean }>;
      ownsProjectRows = rows[0]?.found === true;
    }
    const migrationState = (await tx.execute(sql`
      SELECT to_regclass('public.fusion_sqlite_migrations') IS NOT NULL AS exists
    `)) as unknown as Array<{ exists: boolean }>;
    let ownsMigrationState = false;
    if (migrationState[0]?.exists) {
      const markerRows = (await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM public.fusion_sqlite_migrations
          WHERE project_id = ${fallbackProjectId}
        ) AS found
      `)) as unknown as Array<{ found: boolean }>;
      ownsMigrationState = markerRows[0]?.found === true;
    }
    if (!ownsProjectRows && !ownsMigrationState) return false;

    await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
    for (const { table_name: tableName } of tables) {
      await tx.execute(sql`
        UPDATE ${sql.identifier("project")}.${sql.identifier(tableName)}
        SET project_id = ${registeredProjectId}
        WHERE project_id = ${fallbackProjectId}
      `);
    }
    await tx.execute(sql`
      UPDATE archive.archived_tasks
      SET project_id = ${registeredProjectId}
      WHERE project_id = ${fallbackProjectId}
    `);
    if (migrationState[0]?.exists) {
      await tx.execute(sql`
        UPDATE public.fusion_sqlite_migrations
        SET project_id = ${registeredProjectId}, updated_at = now()
        WHERE project_id = ${fallbackProjectId}
      `);
      await tx.execute(sql`
        INSERT INTO public.fusion_sqlite_migrations(migration_key, project_id, status, last_error, updated_at)
        SELECT ${`project:${registeredProjectId}`}, ${registeredProjectId}, status, last_error, now()
        FROM public.fusion_sqlite_migrations
        WHERE migration_key = ${`project:${fallbackProjectId}`}
        ON CONFLICT (migration_key) DO UPDATE
        SET project_id = EXCLUDED.project_id,
            status = EXCLUDED.status,
            last_error = EXCLUDED.last_error,
            updated_at = now()
      `);
    }
    return true;
  });
}

/**
 * FNXC:CentralProjectIdentity 2026-07-13-23:10:
 * Re-key just-migrated rows to the booting project's central-registry id.
 *
 * Covers, idempotently:
 *   - project.tasks           NULL project_id → projectId
 *   - project.archived_tasks  NULL project_id → projectId
 *   - archive.archived_tasks  NULL project_id → projectId (cold-storage snapshots)
 *   - project.config          '' key → projectId (guarded: never clobbers a
 *                             pre-existing per-project row)
 *   - project.workflow_settings          rootDir-path key → projectId (guarded)
 *   - project.workflow_prompt_overrides  rootDir-path key → projectId (guarded)
 *
 * Callers must guarantee the NULL-project_id rows in tasks/archived_tasks were
 * written by THIS migration pass (the scoped emptiness check in startup-factory
 * Step 5.5, or the empty-target contract of `fn db migrate`). The config /
 * workflow re-keys are NOT_EXISTS-guarded so a pre-existing per-project row is
 * never destroyed.
 *
 * @param db A Drizzle instance connected to the target cluster (the same type
 *   startup-factory uses for `connections.migration`). Must run DML.
 */
export async function stampMigratedProjectRows(
  db: MigrationDb,
  { projectId, rootDir }: StampMigratedProjectRowsInput,
): Promise<StampMigratedProjectRowsResult> {
  if (!projectId) {
    // No registry identity — leave rows unstamped (unregistered single-project
    // setups use an unbound layer with no scope filter).
    return { stamped: false };
  }

  /*
  FNXC:MultiProjectIsolation 2026-07-11:
  The SQLite migrator predates partitioning and leaves project_id NULL — rows
  the strict taskProjectScope filter (project_id = $bound) would never surface,
  so the scheduler/board would show an empty project right after a "successful"
  migration. Stamp the just-migrated rows with the booting project's id.

  FNXC:MultiProjectIsolation 2026-07-13-21:20:
  The stamping id must also be derivable WITHOUT options.projectId — the main
  cutover path (`fn dashboard` in the project directory) boots with rootDir
  only, so the previous `if (options.projectId)` guard skipped stamping on
  exactly the boot that performs most real-world migrations. The resolution now
  falls back to a central-registry path lookup (done by the caller).

  FNXC:ProjectDataIsolation 2026-07-14-16:50:
  Schema migration 0006 quarantines ownerless rows when no unique migration owner existed at schema-upgrade time. A later verified startup cutover may claim that quarantine only when the migration ledger now identifies exactly one non-empty project and it is this project; multi-project or otherwise ambiguous quarantines remain untouched for operator reconciliation.
  */
  /*
  FNXC:ProjectMigrationStamping 2026-07-14-21:55:
  Partition stamping is one atomic promotion. If any table cannot be re-keyed, roll back every earlier update so startup never exposes a partially migrated project identity.
  */
  return db.transaction(async (tx) => {
    await acquireSqliteMigrationStateLock(tx);
    return stampMigratedProjectRowsWithinTransaction(tx, projectId, rootDir);
  });
}

async function stampMigratedProjectRowsWithinTransaction(
  tx: MigrationTransaction,
  projectId: string,
  rootDir: string,
): Promise<StampMigratedProjectRowsResult> {
  const stateTable = (await tx.execute(sql`
    SELECT to_regclass('public.fusion_sqlite_migrations') IS NOT NULL AS exists
  `)) as unknown as Array<{ exists: boolean }>;
  let canClaimLegacyQuarantine = false;
  if (stateTable[0]?.exists) {
    const ownershipRows = (await tx.execute(sql`
      SELECT count(DISTINCT project_id)::int AS project_count,
             min(project_id) AS only_project_id
      FROM public.fusion_sqlite_migrations
      WHERE project_id IS NOT NULL AND project_id <> ''
    `)) as unknown as Array<{ project_count: number; only_project_id: string | null }>;
    canClaimLegacyQuarantine =
      ownershipRows[0]?.project_count === 1 && ownershipRows[0]?.only_project_id === projectId;
  }

  await tx.execute(
    sql`UPDATE project.tasks SET project_id = ${projectId}
        WHERE project_id IS NULL
           OR (${canClaimLegacyQuarantine} AND project_id = '__legacy_unscoped__')`,
  );
  await tx.execute(
    sql`UPDATE project.archived_tasks SET project_id = ${projectId}
        WHERE project_id IS NULL
           OR (${canClaimLegacyQuarantine} AND project_id = '__legacy_unscoped__')`,
  );
  // The cold-storage archive is also partitioned (PR #2007 review P1); migrated
  // snapshots must be owned by this project too.
  await tx.execute(
    sql`UPDATE archive.archived_tasks SET project_id = ${projectId}
        WHERE project_id IS NULL
           OR (${canClaimLegacyQuarantine} AND project_id = '__legacy_unscoped__')`,
  );

  /*
  FNXC:CentralProjectIdentity 2026-07-13-22:00:
  project.config is keyed by project_id (DEFAULT '' — the legacy SQLite-parity
  row). The migrator copies the legacy singleton config into the '' row, but
  configScope() has NO bound→'' fallback, so a bound reader silently lost the
  migrated project settings, workflowSteps, taskPrefix, and nextId floor
  (defaults returned right after a "successful" migration). Re-key the migrated
  row to this project. Guarded so a pre-existing per-project row is never
  clobbered (then the '' row is left for manual reconciliation rather than
  destroying either copy).
  */
  await tx.execute(
    sql`UPDATE project.config SET project_id = ${projectId}
      WHERE (project_id = '' OR (${canClaimLegacyQuarantine} AND project_id = '__legacy_unscoped__'))
        AND NOT EXISTS (SELECT 1 FROM project.config WHERE project_id = ${projectId})`,
  );

  /*
  FNXC:CentralProjectIdentity 2026-07-13-23:10:
  project.workflow_settings and project.workflow_prompt_overrides are keyed
  (workflow_id, project_id). The runtime now keys them by the central-registry
  project id (asyncLayer.projectId), but legacy/migrated rows carry the
  pre-isolation key — the absolute rootDir path string (e.g.
  '/Users/eclipxe/Projects/kb') or a legacy identity id. A bound
  workflow-settings resolver filters those out, so per-workflow setting VALUES
  and prompt overrides vanish right after a "successful" migration (defaults
  returned, custom prompts lost). Re-key the rootDir-path rows to this project.
  Guarded per-row with NOT EXISTS on the target (workflow_id, projectId) PK so a
  unique violation never clobbers a pre-existing per-project row (the outer
  table alias in the correlated subquery references the row being updated).
  */
  await tx.execute(
    sql`UPDATE project.workflow_settings SET project_id = ${projectId}
      WHERE project_id = ${rootDir}
        AND NOT EXISTS (
          SELECT 1 FROM project.workflow_settings w2
          WHERE w2.workflow_id = project.workflow_settings.workflow_id
            AND w2.project_id = ${projectId}
        )`,
  );
  await tx.execute(
    sql`UPDATE project.workflow_prompt_overrides SET project_id = ${projectId}
      WHERE project_id = ${rootDir}
        AND NOT EXISTS (
          SELECT 1 FROM project.workflow_prompt_overrides w2
          WHERE w2.workflow_id = project.workflow_prompt_overrides.workflow_id
            AND w2.project_id = ${projectId}
        )`,
  );

  return { stamped: true };
}

/**
 * FNXC:CentralProjectIdentity 2026-07-13-23:10:
 * Resolve the central-registry project id for a filesystem path by matching
 * central.projects.path. Shared so both startup-factory (rootDir-only boot) and
 * `fn db migrate` (post-migration, once central.projects is populated) derive
 * the same stamping id. Returns undefined when the path is not registered
 * (legacy/unregistered single-project setups stay unbound, matching their
 * unfiltered readers). Never throws — a lookup failure yields undefined.
 */
export async function lookupRegisteredProjectIdByPath(
  db: MigrationDb,
  path: string,
): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const rows = (await db.execute(
      sql`SELECT id FROM central.projects WHERE path = ${path} LIMIT 1`,
    )) as Array<{ id: string }>;
    return rows[0]?.id;
  } catch {
    return undefined;
  }
}

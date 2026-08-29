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

export interface ProjectPartitionOwnership {
  readonly fallbackProjectId: string;
  readonly registeredProjectId: string;
  readonly fallbackOwnedRows: boolean;
  readonly registeredOwnedRows: boolean;
  readonly ownershipByRelation: Record<string, { fallback: boolean; registered: boolean }>;
}

export type ProjectPartitionRekeyReason =
  | "unreplaced-fk-dependent"
  | "unsupported-unique-metadata"
  | "unsafe-fk-update-graph"
  | "unique-violation"
  | "unknown";

/** A fail-closed promotion result that also preserves the pre-write bind decision. */
export class ProjectPartitionRekeyError extends Error {
  constructor(
    readonly reason: ProjectPartitionRekeyReason,
    readonly ownership: ProjectPartitionOwnership,
    readonly details: string,
    options?: ErrorOptions,
  ) {
    super(`Project partition reconciliation refused (${reason}): ${details}`, options);
    this.name = "ProjectPartitionRekeyError";
  }
}

export function selectDegradedBindTarget(
  ownership: ProjectPartitionOwnership | undefined,
): "fallback" | "registered" | "refuse" {
  if (!ownership) return "refuse";
  if (ownership.fallbackOwnedRows) return "fallback";
  return ownership.registeredOwnedRows ? "registered" : "refuse";
}

type RekeyTarget = { schema: string; table: string };
type UniqueRule = { schema: string; table: string; name: string; columns: string[]; nullsNotDistinct: boolean; partial: boolean; expression: boolean };
type ForeignKey = { constraintId: string; constraintName: string; childSchema: string; childTable: string; parentSchema: string; parentTable: string; childColumns: string[]; parentColumns: string[]; deferrable: boolean; updateAction: string; deleteAction: string };

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
function relationName(target: RekeyTarget): string { return `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.table)}`; }
function relationKey(target: RekeyTarget): string { return `${target.schema}.${target.table}`; }
// Project identifiers originate from central storage, but quote them here because catalog-driven SQL cannot bind identifiers and must remain injection-safe.
function quoteLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

/**
 * FNXC:ProjectPartitionMerge 2026-07-20-12:00:
 * A registered project can legitimately have older path-fallback rows. Promotion is a single catalog-driven merge, not a NOT EXISTS skip: fallback rows win conflicts so registration scaffolding cannot discard operator settings. Normal UNIQUE keys require non-NULL equality while NULLS NOT DISTINCT keys use IS NOT DISTINCT FROM.
 *
 * FNXC:ProjectPartitionMerge 2026-07-20-12:00:
 * Before writes, reject metadata we cannot model and unsafe update FK edges. Registered rows are deleted only for a proven unique conflict; any inbound registered dependent makes that delete fail closed regardless of CASCADE/SET NULL/SET DEFAULT, rather than using an FK action as data cleanup. The typed error retains pre-transaction ownership so startup can safely bind fallback after rollback.
 *
 * FNXC:ProjectPartitionMerge 2026-07-20-12:30:
 * Evaluate each catalog FK constraint independently: aggregating separate edges can miss a dependent and permit a collateral cascade. DEFERRABLE only permits deferred checks; ON UPDATE SET NULL/SET DEFAULT remain unsafe because they can mutate retained children during promotion.
 */
export async function rekeyFallbackProjectPartition(
  db: MigrationDb,
  fallbackProjectId: string,
  registeredProjectId: string,
): Promise<boolean> {
  if (!fallbackProjectId || fallbackProjectId === registeredProjectId) return false;

  return db.transaction(async (tx) => {
    // This remains the first statement: migration-stamping-lock-order.test.ts enforces it.
    await acquireSqliteMigrationStateLock(tx);
    const targets = (await tx.execute(sql`
      SELECT table_schema AS schema, table_name AS table
      FROM information_schema.columns
      WHERE table_schema = 'project' AND column_name = 'project_id'
      UNION ALL SELECT 'archive', 'archived_tasks'
      WHERE to_regclass('archive.archived_tasks') IS NOT NULL
      ORDER BY 1, 2
    `)) as unknown as RekeyTarget[];
    const ownershipByRelation: Record<string, { fallback: boolean; registered: boolean }> = {};
    for (const target of targets) {
      const rows = (await tx.execute(sql.raw(`SELECT EXISTS (SELECT 1 FROM ${relationName(target)} WHERE project_id = ${quoteLiteral(fallbackProjectId)}) AS fallback, EXISTS (SELECT 1 FROM ${relationName(target)} WHERE project_id = ${quoteLiteral(registeredProjectId)}) AS registered`))) as unknown as Array<{ fallback: boolean; registered: boolean }>;
      ownershipByRelation[relationKey(target)] = rows[0] ?? { fallback: false, registered: false };
    }
    const stateExists = (await tx.execute(sql`SELECT to_regclass('public.fusion_sqlite_migrations') IS NOT NULL AS exists`)) as unknown as Array<{ exists: boolean }>;
    let fallbackMigration = false;
    let registeredMigration = false;
    if (stateExists[0]?.exists) {
      const rows = (await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM public.fusion_sqlite_migrations WHERE project_id = ${fallbackProjectId}) AS fallback, EXISTS (SELECT 1 FROM public.fusion_sqlite_migrations WHERE project_id = ${registeredProjectId}) AS registered`)) as unknown as Array<{ fallback: boolean; registered: boolean }>;
      fallbackMigration = rows[0]?.fallback === true;
      registeredMigration = rows[0]?.registered === true;
      ownershipByRelation["public.fusion_sqlite_migrations"] = { fallback: fallbackMigration, registered: registeredMigration };
    }
    const ownership: ProjectPartitionOwnership = {
      fallbackProjectId, registeredProjectId,
      fallbackOwnedRows: fallbackMigration || Object.values(ownershipByRelation).some((row) => row.fallback),
      registeredOwnedRows: registeredMigration || Object.values(ownershipByRelation).some((row) => row.registered),
      ownershipByRelation,
    };
    if (!ownership.fallbackOwnedRows) return false;

    const uniqueRules = (await tx.execute(sql`
      SELECT ns.nspname AS schema, cls.relname AS table, idx.relname AS name,
             array_agg(att.attname ORDER BY ord.n) AS columns,
             COALESCE(ind.indnullsnotdistinct, false) AS "nullsNotDistinct",
             ind.indpred IS NOT NULL AS partial, ind.indexprs IS NOT NULL AS expression
      FROM pg_index ind
      JOIN pg_class cls ON cls.oid = ind.indrelid
      JOIN pg_namespace ns ON ns.oid = cls.relnamespace
      JOIN pg_class idx ON idx.oid = ind.indexrelid
      -- FNXC:ProjectPartitionMerge 2026-07-20-12:45: indkey also contains non-key INCLUDE attributes; only indnkeyatts participate in a unique conflict after project_id is rewritten.
      JOIN LATERAL unnest(ind.indkey::smallint[]) WITH ORDINALITY ord(attnum, n)
        ON ord.n <= ind.indnkeyatts
      LEFT JOIN pg_attribute att ON att.attrelid = cls.oid AND att.attnum = ord.attnum
      WHERE ind.indisunique
        AND (ns.nspname = 'project' OR (ns.nspname = 'archive' AND cls.relname = 'archived_tasks'))
      GROUP BY ns.nspname, cls.relname, idx.relname, ind.indnullsnotdistinct, ind.indpred, ind.indexprs
    `)) as unknown as UniqueRule[];
    const targetKeys = new Set(targets.map(relationKey));
    const relevantRules = uniqueRules.filter((rule) => {
      const rows = ownershipByRelation[`${rule.schema}.${rule.table}`];
      /* FNXC:ProjectPartitionMerge 2026-07-20-12:45: A partial/expression rule can depend on project_id even when its key attrs do not. We cannot evaluate that predicate safely, so include it in the fail-closed metadata pass whenever fallback rows will be moved. */
      return targetKeys.has(`${rule.schema}.${rule.table}`) && rows?.fallback
        && (rule.columns.includes("project_id") || rule.expression || rule.partial)
        // Without a registered row this rewrite cannot introduce a second
        // member of the index, so opaque predicates have no conflict to model.
        && rows.registered;
    });
    for (const rule of relevantRules) {
      if (rule.expression || rule.partial || rule.columns.some((column) => !column)) {
        throw new ProjectPartitionRekeyError("unsupported-unique-metadata", ownership, `${rule.schema}.${rule.table}.${rule.name}`);
      }
    }

    const fks = (await tx.execute(sql`
      SELECT con.oid::text AS "constraintId", con.conname AS "constraintName",
             cns.nspname AS "childSchema", child.relname AS "childTable",
             pns.nspname AS "parentSchema", parent.relname AS "parentTable",
             array_agg(ca.attname ORDER BY keys.n) FILTER (WHERE ca.attname IS NOT NULL) AS "childColumns",
             array_agg(pa.attname ORDER BY keys.n) FILTER (WHERE pa.attname IS NOT NULL) AS "parentColumns",
             con.condeferrable AS deferrable, con.confupdtype AS "updateAction", con.confdeltype AS "deleteAction"
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid JOIN pg_namespace cns ON cns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = con.confrelid JOIN pg_namespace pns ON pns.oid = parent.relnamespace
      JOIN LATERAL unnest(con.conkey) WITH ORDINALITY keys(attnum, n) ON true
      LEFT JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = keys.attnum
      LEFT JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[keys.n]
      WHERE con.contype = 'f'
      GROUP BY con.oid, con.conname, cns.nspname, child.relname, pns.nspname, parent.relname, con.condeferrable, con.confupdtype, con.confdeltype
    `)) as unknown as ForeignKey[];
    const updateUnsafe = fks.find((fk) => {
      const parentRows = ownershipByRelation[`${fk.parentSchema}.${fk.parentTable}`];
      const childRows = ownershipByRelation[`${fk.childSchema}.${fk.childTable}`];
      const rewritesFkIdentity = fk.parentColumns.includes("project_id")
        || (targetKeys.has(`${fk.childSchema}.${fk.childTable}`) && fk.childColumns.includes("project_id"));
      // SET NULL/DEFAULT mutates retained children even when the check is deferred.
      const mutatesChild = fk.updateAction === "n" || fk.updateAction === "d";
      const childIsRekeyed = targetKeys.has(`${fk.childSchema}.${fk.childTable}`);
      /* FNXC:ProjectPartitionMerge 2026-07-20-12:45: A deferred check only makes a two-sided rekey safe: an external child is never rewritten by this loop and would still reference the fallback key at commit. CASCADE is the only catalog action that can safely update it. */
      const deferredExternalChild = fk.deferrable && !childIsRekeyed;
      return targetKeys.has(`${fk.parentSchema}.${fk.parentTable}`)
        && (parentRows?.fallback || childRows?.fallback)
        && rewritesFkIdentity
        && (mutatesChild || deferredExternalChild || (!fk.deferrable && fk.updateAction !== "c"));
    });
    if (updateUnsafe) {
      throw new ProjectPartitionRekeyError("unsafe-fk-update-graph", ownership, `${updateUnsafe.childSchema}.${updateUnsafe.childTable} -> ${updateUnsafe.parentSchema}.${updateUnsafe.parentTable}`);
    }

    await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
    await tx.execute(sql.raw(`CREATE TEMP TABLE fusion_rekey_conflict_candidates (
      schema_name text NOT NULL, table_name text NOT NULL, row_id tid NOT NULL,
      PRIMARY KEY (schema_name, table_name, row_id)
    ) ON COMMIT DROP`));

    // Compute the complete delete plan before deleting a parent. A dependent is
    // safe only when it is itself a registered conflict candidate; this is the
    // proof that its fallback counterpart replaces it after promotion.
    for (const rule of relevantRules) {
      const target: RekeyTarget = { schema: rule.schema, table: rule.table };
      const nonProjectColumns = rule.columns.filter((column) => column !== "project_id");
      const predicate = nonProjectColumns.length === 0
        ? "TRUE"
        : rule.nullsNotDistinct
          ? nonProjectColumns.map((column) => `reg.${quoteIdentifier(column)} IS NOT DISTINCT FROM fb.${quoteIdentifier(column)}`).join(" AND ")
          : nonProjectColumns.map((column) => `reg.${quoteIdentifier(column)} IS NOT NULL AND fb.${quoteIdentifier(column)} IS NOT NULL AND reg.${quoteIdentifier(column)} = fb.${quoteIdentifier(column)}`).join(" AND ");
      await tx.execute(sql.raw(`INSERT INTO fusion_rekey_conflict_candidates(schema_name, table_name, row_id)
        SELECT ${quoteLiteral(rule.schema)}, ${quoteLiteral(rule.table)}, reg.ctid
        FROM ${relationName(target)} reg
        WHERE reg.project_id = ${quoteLiteral(registeredProjectId)}
          AND EXISTS (SELECT 1 FROM ${relationName(target)} fb
            WHERE fb.project_id = ${quoteLiteral(fallbackProjectId)} AND ${predicate})
        ON CONFLICT DO NOTHING`));
    }

    for (const fk of fks) {
      const parentKey = `${fk.parentSchema}.${fk.parentTable}`;
      if (!targetKeys.has(parentKey)) continue;
      const childTarget = targetKeys.has(`${fk.childSchema}.${fk.childTable}`);
      const join = fk.childColumns.map((column, index) => `child.${quoteIdentifier(column)} IS NOT DISTINCT FROM parent.${quoteIdentifier(fk.parentColumns[index]!)}`).join(" AND ");
      const registeredChildScope = childTarget
        ? ` AND child.${quoteIdentifier("project_id")} = ${quoteLiteral(registeredProjectId)}`
        : "";
      const unreplaced = (await tx.execute(sql.raw(`SELECT EXISTS (
        SELECT 1 FROM ${relationName({ schema: fk.childSchema, table: fk.childTable })} child
        JOIN ${relationName({ schema: fk.parentSchema, table: fk.parentTable })} parent ON ${join}
        JOIN fusion_rekey_conflict_candidates parent_candidate
          ON parent_candidate.schema_name = ${quoteLiteral(fk.parentSchema)}
         AND parent_candidate.table_name = ${quoteLiteral(fk.parentTable)}
         AND parent_candidate.row_id = parent.ctid
        WHERE 1 = 1${registeredChildScope}
          AND NOT EXISTS (SELECT 1 FROM fusion_rekey_conflict_candidates child_candidate
            WHERE child_candidate.schema_name = ${quoteLiteral(fk.childSchema)}
              AND child_candidate.table_name = ${quoteLiteral(fk.childTable)}
              AND child_candidate.row_id = child.ctid)
      ) AS found`))) as unknown as Array<{ found: boolean }>;
      if (unreplaced[0]?.found) {
        throw new ProjectPartitionRekeyError("unreplaced-fk-dependent", ownership, `${fk.constraintName || fk.constraintId}: ${fk.childSchema}.${fk.childTable} (${fk.deleteAction}) depends on ${fk.parentSchema}.${fk.parentTable}`);
      }
    }

    /*
    FNXC:ProjectPartitionMerge 2026-07-20-13:15:
    Delete only the precomputed registered conflict set, children before parents.
    This permits a fallback-wins parent/child merge when every removed child has
    its own fallback replacement, while an unreplaced child aborts before any
    ON DELETE CASCADE, SET NULL, or SET DEFAULT side effect can run.
    */
    const pending = new Set(targets.map(relationKey));
    while (pending.size > 0) {
      const next = [...pending].find((key) => !fks.some((fk) =>
        `${fk.parentSchema}.${fk.parentTable}` === key
        && pending.has(`${fk.childSchema}.${fk.childTable}`)
        && `${fk.childSchema}.${fk.childTable}` !== key,
      ));
      // A non-deferrable delete cycle has no statement-safe child-first order.
      const deferredCycle = !next && [...pending].every((key) => fks
        .filter((fk) => `${fk.parentSchema}.${fk.parentTable}` === key && pending.has(`${fk.childSchema}.${fk.childTable}`))
        .every((fk) => fk.deferrable));
      if (!next && !deferredCycle) {
        throw new ProjectPartitionRekeyError("unknown", ownership, "non-deferrable conflict-delete FK cycle");
      }
      const deleteKey = next ?? [...pending][0]!;
      const [schema, table] = deleteKey.split(".");
      await tx.execute(sql.raw(`DELETE FROM ${relationName({ schema: schema!, table: table! })} reg
        USING fusion_rekey_conflict_candidates candidate
        WHERE candidate.schema_name = ${quoteLiteral(schema!)}
          AND candidate.table_name = ${quoteLiteral(table!)}
          AND candidate.row_id = reg.ctid`));
      pending.delete(deleteKey);
    }
    // ON UPDATE CASCADE changes child keys with its parent statement, so its
    // parent must run first; deferred edges have no statement-order constraint.
    const updatePending = new Map(targets.map((target) => [relationKey(target), target]));
    while (updatePending.size > 0) {
      const target = [...updatePending.values()].find((candidate) => !fks.some((fk) =>
        `${fk.childSchema}.${fk.childTable}` === relationKey(candidate)
        && updatePending.has(`${fk.parentSchema}.${fk.parentTable}`)
        && fk.updateAction === "c",
      ));
      const next = target ?? updatePending.values().next().value as RekeyTarget;
      await tx.execute(sql.raw(`UPDATE ${relationName(next)} SET project_id = ${quoteLiteral(registeredProjectId)} WHERE project_id = ${quoteLiteral(fallbackProjectId)}`));
      updatePending.delete(relationKey(next));
    }
    if (stateExists[0]?.exists) {
      await tx.execute(sql`UPDATE public.fusion_sqlite_migrations SET project_id = ${registeredProjectId}, updated_at = now() WHERE project_id = ${fallbackProjectId}`);
      await tx.execute(sql`INSERT INTO public.fusion_sqlite_migrations(migration_key, project_id, status, last_error, updated_at) SELECT ${`project:${registeredProjectId}`}, ${registeredProjectId}, status, last_error, now() FROM public.fusion_sqlite_migrations WHERE migration_key = ${`project:${fallbackProjectId}`} ON CONFLICT (migration_key) DO UPDATE SET project_id = EXCLUDED.project_id, status = EXCLUDED.status, last_error = EXCLUDED.last_error, updated_at = now()`);
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

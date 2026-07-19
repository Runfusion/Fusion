/**
 * PostgreSQL schema applier.
 *
 * FNXC:PostgresSchema 2026-06-24-03:40:
 * Applies the fresh Drizzle migration baseline to a PostgreSQL connection
 * and records it in a migration bookkeeping table. The baseline migration
 * (migrations/0000_initial.sql) is the snapshot of the final SQLite schema
 * (SCHEMA_VERSION=128) translated to PostgreSQL — applying it to an empty
 * database yields final-schema parity (VAL-SCHEMA-001).
 *
 * After the baseline lands, plugin-owned tables are materialized via the
 * schema-init hook (VAL-SCHEMA-007). The applier calls each registered plugin
 * hook so plugins evolve their own tables independently of the core migration.
 *
 * Migration tracking uses a single-row bookkeeping table in the public schema
 * so the applier is idempotent: re-running against an already-migrated database
 * is a no-op. The version-gate discipline (the institutional learning that
 * fresh-DB tests cannot catch a skipped-on-upgrade migration) is carried
 * forward via the applier's explicit baseline marker.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { runPluginSchemaInitHooks, DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS, type PluginSchemaInitHook } from "./plugin-schema-hook.js";
import { acquireSchemaMutationLocks } from "./advisory-locks.js";

/** The latest PostgreSQL schema version known to this applier. */
/*
FNXC:GitHubImportTranslate 2026-07-17-23:48:
Advances to 0019 for the import-translation legacy-partition backfill. Per-migration identities above stay fixed; only this latest-version marker moves.

FNXC:PostgresBigintCounters 2026-07-19-12:00:
SCHEMA_BASELINE_VERSION advances to 0026 for the bigint counters migration.
Per-migration identities above stay fixed; only this latest-version marker moves.
*/
export const SCHEMA_BASELINE_VERSION = "0027";
const INITIAL_SCHEMA_VERSION = "0000";
const AUTOMATION_ISOLATION_SCHEMA_VERSION = "0001";
const ANALYTICS_ISOLATION_SCHEMA_VERSION = "0002";
/**
 * FNXC:PostgresMigrationIdentity 2026-07-14-01:41:
 * Each migration keeps an immutable bookkeeping identity even as SCHEMA_BASELINE_VERSION advances to newer migrations. Upgrade checks and inserts must use this dedicated 0003 identifier so a later latest-version marker cannot make an unrecorded monitor/approval migration look applied.
 */
export const MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION = "0003";
export const LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION = "0004";
export const MULTI_PROJECT_CUTOVER_SCHEMA_VERSION = "0005";
export const PROJECT_OWNERSHIP_SCHEMA_VERSION = "0006";
export const SQLITE_SCHEMA_PARITY_VERSION = "0007";
/**
 * FNXC:PlannerOversight 2026-07-14-18:49:
 * Version 0008 adds project.tasks.session_advisor_enabled for per-task session
 * advisor overrides. Keep this identity fixed when SCHEMA_BASELINE_VERSION advances.
 */
export const SESSION_ADVISOR_ENABLED_SCHEMA_VERSION = "0008";
export const MISSION_FIX_IDEMPOTENCY_VERSION = "0009";
/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Import-translation cache advances to 0010. Migrations are registered here explicitly (not auto-discovered from the migrations dir), so a new .sql file that is not wired through a version constant + bookkeeping check silently never runs.
*/
export const IMPORT_TRANSLATION_CACHE_VERSION = "0010";
/**
 * FNXC:GitHubImportTranslate 2026-07-16-23:30:
 * Existing databases already recorded 0010, so the cache scope correction is
 * deliberately a new forward migration rather than a retroactive SQL edit.
 */
export const IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION = "0016";
/*
FNXC:GitHubImportTranslate 2026-07-17-23:48:
0016 aligned future cache writes with the normalized legacy partition, but a
pre-0016 cache row can still carry a historic blank project_id. Migration 0019
backfills that durable data before a restarted store scopes cache reads to
__legacy_unscoped__, preventing an avoidable re-translation.
*/
export const IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION = "0019";
/*
FNXC:MultiProjectIsolation 2026-07-15-23:40:
Version 0011 splits the domain "project" field from the RLS partition on the tables
that conflated them: `project_id` stays the trigger/GUC-owned isolation partition,
`owner_project_id` becomes the caller-supplied domain field. Writing domain values
into the partition put parent rows and child rows in different partitions and broke
the composite FKs (SQLSTATE 23503). Keep this identity fixed when
SCHEMA_BASELINE_VERSION advances.
*/
export const OWNER_PROJECT_ID_SPLIT_VERSION = "0011";
/*
FNXC:ChatPinned 2026-07-16-12:30:
Version 0012 makes the persisted pin timestamp available on databases that
already applied the baseline before Direct conversations can be pinned.
*/
export const CHAT_SESSION_PINS_VERSION = "0012";
/** FNXC:ExecutorToolFailureRetry 2026-07-16-12:00: upgrades existing PostgreSQL task rows before retry-state reads. */
export const EXECUTOR_TOOL_FAILURE_RETRY_VERSION = "0013";
/** FNXC:ExecutorEscalation 2026-07-16-21:00: Existing clusters need the durable single-shot latch before executor reads it during post-FN-7996 escalation. */
export const EXECUTOR_ESCALATION_ATTEMPT_VERSION = "0014";
/** FNXC:PostgresSchema 2026-07-16-22:00: central global routines follow main's already-landed 0014 migration. */
export const GLOBAL_ROUTINES_SCHEMA_VERSION = "0015";
/** FNXC:Settings-MergerModel 2026-07-16-12:00: per-task merger lane is an additive upgrade. */
export const TASK_MERGER_MODEL_LANE_VERSION = "0017";
/**
 * FNXC:Lifecycle 2026-07-16-22:35:
 * Version 0018 lands project.tasks.bulk_completion_refusal_at (FN-8141) on
 * existing clusters. PR #2260 added the column to the model + 0000 baseline but
 * forgot the forward migration, so every pre-#2260 database crashed on its first
 * TaskStore SELECT. Keep this identity fixed when SCHEMA_BASELINE_VERSION advances.
 */
export const BULK_COMPLETION_REFUSAL_AT_VERSION = "0018";
/** FNXC:EphemeralAgentTaskCreation 2026-07-30-12:00: durable project-scoped proposal key/index protects task creation across crash and reclaim races. */
export const TASK_PROPOSAL_CLAIM_VERSION = "0020";
/** FNXC:ConfigVersioning 2026-07-18-00:00: existing clusters need immutable configuration history before write paths use it. */
export const CONFIGURATION_REVISIONS_VERSION = "0021";
/** FNXC:Ideation 2026-07-30-15:30: Persisted ideation needs its own forward migration because configuration revisions already own 0021. */
export const IDEATION_SCHEMA_VERSION = "0022";
/** FNXC:ResearchMissionBridge 2026-07-18-12:00: forward migration stores stable research finding provenance on canonical features. */
export const RESEARCH_FEATURE_PROVENANCE_VERSION = "0023";
/** FNXC:TaskVerificationRequest 2026-07-30-00:00: upgrades need the project-scoped chat-to-executor verification queue. */
export const TASK_VERIFICATION_REQUEST_VERSION = "0024";
/** FNXC:SymbolLock 2026-07-30-14:10: upgraded projects need the durable lock table and RLS contract before scheduler admission can use it. */
export const SYMBOL_LOCKS_SCHEMA_VERSION = "0025";
/** FNXC:PostgresBigintCounters 2026-07-18-21:45: widen overflow-prone counters to bigint before SQLite migration. */
export const BIGINT_COUNTERS_VERSION = "0026";

/**
 * Thrown when the database was migrated by a NEWER Fusion binary than the one now
 * opening it. Carries the offending versions so the operator sees what to upgrade.
 */
export class StaleBinarySchemaError extends Error {
  constructor(
    readonly databaseVersion: string,
    readonly binaryVersion: string,
  ) {
    super(
      `This Fusion binary is older than the database it opened: the database has schema `
      + `migration ${databaseVersion} applied, but this binary only knows up to `
      + `${binaryVersion}. Refusing to open so an old binary cannot write rows the newer `
      + `schema's invariants depend on. Upgrade Fusion (e.g. \`brew upgrade fusion\`) and retry.`,
    );
    this.name = "StaleBinarySchemaError";
  }
}

/*
FNXC:StaleBinaryGuard 2026-07-19-03:10 (U9b / R10):
Old-binary write refusal. Migration bookkeeping is forward-only, so a database carrying a
version ABOVE this binary's SCHEMA_BASELINE_VERSION was migrated by a newer Fusion. Letting
the old binary proceed writes rows using the previous schema's assumptions (the observed
stale-Homebrew-binary failure mode). Compared numerically, not lexically; unparseable
identifiers are ignored so a plugin marker cannot brick every open.

FNXC:LegacyAdoption 2026-07-19-14:30 (PR #2341 review):
The ignore-unparseable rule is a load-bearing coupling, not just plugin defense:
LEGACY_ADOPTION_DRAINED_MARKER (below) is a deliberately NON-NUMERIC bookkeeping row that
`adoptLegacyTaskRowsOnOpen` (task-store/lifecycle-ops.ts) writes into
fusion_schema_migrations after a fully-drained adoption sweep. This guard MUST keep
skipping non-numeric versions, or the marker would present as a "newer database" and
brick every open.
*/
export function assertBinaryNotOlderThanDatabase(applied: readonly string[]): void {
  const binaryVersion = Number(SCHEMA_BASELINE_VERSION);
  if (!Number.isFinite(binaryVersion)) return;
  let highest = -Infinity;
  let highestRaw = "";
  for (const version of applied) {
    const parsed = Number(version);
    if (!Number.isFinite(parsed)) continue;
    if (parsed > highest) {
      highest = parsed;
      highestRaw = version;
    }
  }
  if (highest > binaryVersion) {
    throw new StaleBinarySchemaError(highestRaw, SCHEMA_BASELINE_VERSION);
  }
}

/** Bookkeeping table for the fresh Drizzle migration history. */
export const MIGRATION_BOOKKEEPING_TABLE = "fusion_schema_migrations";

/*
FNXC:LegacyAdoption 2026-07-19-14:30 (PR #2341 review):
Durable "legacy adoption fully drained" marker row in fusion_schema_migrations.
Written by the store-open adoption sweep after a full paginated drain in which no
row produced a mutating adoption plan; its presence lets subsequent opens skip the
whole-active-census scan (which would otherwise run on every open forever).
Deliberately NON-NUMERIC so assertBinaryNotOlderThanDatabase ignores it by design
(see that guard's FNXC note — the two sites are coupled).
*/
export const LEGACY_ADOPTION_DRAINED_MARKER = "legacy-adoption-drained";

const __dirname = dirname(fileURLToPath(import.meta.url));

/*
FNXC:StandaloneExeMigrations 2026-07-17-13:30:
The bun-compiled standalone `fn` binary runs its bundled code from the virtual
/$bunfs/root filesystem, so the historical `join(__dirname, "migrations")`
resolution points at a path that does not exist on disk (bun --compile does not
embed readFile assets) and every DATABASE_URL boot died with
ENOENT /$bunfs/root/migrations/0000_initial.sql. Resolution order:
  1. FUSION_MIGRATIONS_DIR env override — always wins when set (operator escape hatch).
  2. join(__dirname, "migrations") — the npm/tsup and desktop layout; kept first
     among the probes so nothing changes for existing installs.
  3. join(dirname(process.execPath), "migrations") — the standalone-exe layout,
     where build.ts / the release tarball stage migrations/ next to the binary.
The existsSync probe (not a runtime-detection heuristic) picks between (2) and
(3): inside the compiled binary the module-relative dir simply does not exist,
while for node-based installs it always does, so npm/desktop behavior is untouched.
*/
function resolveMigrationsDir(): string {
  const envDir = process.env.FUSION_MIGRATIONS_DIR;
  if (envDir) return envDir;
  const moduleDir = join(__dirname, "migrations");
  if (existsSync(join(moduleDir, "0000_initial.sql"))) return moduleDir;
  const execDir = join(dirname(process.execPath), "migrations");
  if (existsSync(join(execDir, "0000_initial.sql"))) return execDir;
  // Preserve the historical default (and its historical error message) when
  // neither location exists — the readFile ENOENT remains the diagnostic.
  return moduleDir;
}

const MIGRATIONS_DIR = resolveMigrationsDir();
const BASELINE_MIGRATION_PATH = join(MIGRATIONS_DIR, "0000_initial.sql");
const AUTOMATION_ISOLATION_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0001_automation_project_isolation.sql",
);
const ANALYTICS_ISOLATION_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0002_analytics_project_isolation.sql",
);
const MONITOR_APPROVAL_ISOLATION_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0003_monitor_approval_project_isolation.sql",
);
const LEGACY_CUTOVER_PRESERVATION_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0004_legacy_cutover_preservation.sql",
);
const MULTI_PROJECT_CUTOVER_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0005_multi_project_cutover.sql",
);
const PROJECT_OWNERSHIP_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0006_project_ownership.sql",
);
const SQLITE_SCHEMA_PARITY_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0007_sqlite_schema_parity.sql",
);
const SESSION_ADVISOR_ENABLED_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0008_session_advisor_enabled.sql",
);
const MISSION_FIX_IDEMPOTENCY_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0009_mission_fix_idempotency.sql",
);
const IMPORT_TRANSLATION_CACHE_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0010_import_translation_cache.sql",
);
const IMPORT_TRANSLATION_CACHE_SCOPE_FIX_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0016_import_translation_cache_scope_fix.sql",
);
const IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0019_import_translation_cache_legacy_partition_backfill.sql",
);
const OWNER_PROJECT_ID_SPLIT_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0011_owner_project_id.sql",
);
const CHAT_SESSION_PINS_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0012_chat_session_pins.sql",
);
const EXECUTOR_TOOL_FAILURE_RETRY_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0013_executor_tool_failure_retry.sql",
);
const EXECUTOR_ESCALATION_ATTEMPT_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0014_executor_escalation_attempt.sql",
);
const GLOBAL_ROUTINES_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0015_global_routines.sql",
);
const TASK_MERGER_MODEL_LANE_MIGRATION_PATH = join(MIGRATIONS_DIR, "0017_task_merger_model_lane.sql");
const BULK_COMPLETION_REFUSAL_AT_MIGRATION_PATH = join(MIGRATIONS_DIR, "0018_bulk_completion_refusal_at.sql");
const TASK_PROPOSAL_CLAIM_MIGRATION_PATH = join(MIGRATIONS_DIR, "0020_task_proposal_claim.sql");
const CONFIGURATION_REVISIONS_MIGRATION_PATH = join(MIGRATIONS_DIR, "0021_configuration_revisions.sql");
const IDEATION_MIGRATION_PATH = join(MIGRATIONS_DIR, "0022_ideation.sql");
const RESEARCH_FEATURE_PROVENANCE_MIGRATION_PATH = join(MIGRATIONS_DIR, "0023_research_feature_provenance.sql");
const TASK_VERIFICATION_REQUEST_MIGRATION_PATH = join(MIGRATIONS_DIR, "0024_task_verification_request.sql");
const SYMBOL_LOCKS_MIGRATION_PATH = join(MIGRATIONS_DIR, "0025_symbol_locks.sql");
const BIGINT_COUNTERS_MIGRATION_PATH = join(MIGRATIONS_DIR, "0026_bigint_counters.sql");
/**
 * FNXC:WorkflowIrPin 2026-07-19-03:10 (U9b / KTD-3 + KTD-8; renumbered 0026->0027 after
 * main claimed 0026 for bigint counters):
 * Durable workflow IR pin (+ its node/column entry) and the one-time legacy-adoption
 * stamp. Keep this identity fixed when SCHEMA_BASELINE_VERSION advances.
 */
export const WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION = "0027";
const WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "0027_workflow_ir_pin_and_legacy_adoption.sql",
);

/**
 * Ensure the migration bookkeeping table exists. Lives in the public schema so
 * it survives across the three application schemas and is queryable without
 * search_path qualification.
 */
async function ensureBookkeepingTable(db: PostgresJsDatabase<Record<string, never>>): Promise<void> {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `));
}

/** Read the baseline migration SQL from disk. Exported for tests. */
export async function readBaselineMigrationSql(): Promise<string> {
  return readFile(BASELINE_MIGRATION_PATH, "utf8");
}

/** Return the set of already-applied migration versions, or empty if none. */
export async function getAppliedMigrations(
  db: PostgresJsDatabase<Record<string, never>>,
): Promise<string[]> {
  await ensureBookkeepingTable(db);
  const rows = (await db.execute(
    sql`SELECT version FROM public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} ORDER BY version`,
  )) as unknown as Array<{ version: string }>;
  return rows.map((row) => row.version);
}

/**
 * Apply the fresh baseline migration to the given connection.
 *
 * Idempotent: if the baseline version is already recorded, this is a no-op.
 * After the baseline lands, all registered plugin schema-init hooks run so
 * plugin-owned tables (e.g. roadmap) materialize (VAL-SCHEMA-007).
 *
 * The baseline SQL is applied as a single batch via postgres.js's file/unsafe
 * execution path. It uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT
 * EXISTS throughout, so a partial prior apply is safe to resume.
 */
export async function applySchemaBaseline(
  db: PostgresJsDatabase<Record<string, never>>,
  options: { pluginHooks?: readonly PluginSchemaInitHook[] } = {},
): Promise<{ applied: boolean; pluginHooksRun: number }> {
  /*
   * FNXC:PostgresSchema 2026-07-14-00:05:
   * Schema versions are a cluster-wide invariant. Serialize version discovery,
   * DDL, and bookkeeping in one transaction so concurrent Fusion processes
   * cannot both apply a version or race its primary-key marker.
  */
  return db.transaction(async (tx) => {
    await acquireSchemaMutationLocks(tx);
    await ensureBookkeepingTable(tx);
    /*
    FNXC:PostgresSchema 2026-07-16-00:55:
    FN-8051 requires project, central, and archive to exist before plugin schema-init hooks run.
    Hooks run even when migration markers are already recorded and target project tables, so
    ensure the namespaces unconditionally inside the advisory-locked transaction rather than
    relying on the baseline batch that a marker-present database skips.
    */
    await tx.execute(sql.raw(`
      CREATE SCHEMA IF NOT EXISTS project;
      CREATE SCHEMA IF NOT EXISTS central;
      CREATE SCHEMA IF NOT EXISTS archive;
    `));
    const applied = await getAppliedMigrations(tx);
    const baselineAlreadyApplied = applied.includes(INITIAL_SCHEMA_VERSION);
    const automationIsolationAlreadyApplied = applied.includes(AUTOMATION_ISOLATION_SCHEMA_VERSION);
    const analyticsIsolationAlreadyApplied = applied.includes(ANALYTICS_ISOLATION_SCHEMA_VERSION);
    const monitorApprovalIsolationAlreadyApplied = applied.includes(MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION);
    const legacyCutoverPreservationAlreadyApplied = applied.includes(LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION);
    const multiProjectCutoverAlreadyApplied = applied.includes(MULTI_PROJECT_CUTOVER_SCHEMA_VERSION);
    const projectOwnershipAlreadyApplied = applied.includes(PROJECT_OWNERSHIP_SCHEMA_VERSION);
    const sqliteSchemaParityAlreadyApplied = applied.includes(SQLITE_SCHEMA_PARITY_VERSION);
    const sessionAdvisorEnabledAlreadyApplied = applied.includes(SESSION_ADVISOR_ENABLED_SCHEMA_VERSION);
    const missionFixIdempotencyAlreadyApplied = applied.includes(MISSION_FIX_IDEMPOTENCY_VERSION);
    const importTranslationCacheAlreadyApplied = applied.includes(IMPORT_TRANSLATION_CACHE_VERSION);
    const importTranslationCacheScopeFixAlreadyApplied = applied.includes(IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION);
    const importTranslationCacheLegacyPartitionBackfillAlreadyApplied = applied.includes(IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION);
    const ownerProjectIdSplitAlreadyApplied = applied.includes(OWNER_PROJECT_ID_SPLIT_VERSION);
    const chatSessionPinsAlreadyApplied = applied.includes(CHAT_SESSION_PINS_VERSION);
    const executorToolFailureRetryAlreadyApplied = applied.includes(EXECUTOR_TOOL_FAILURE_RETRY_VERSION);
    const executorEscalationAttemptAlreadyApplied = applied.includes(EXECUTOR_ESCALATION_ATTEMPT_VERSION);
    const globalRoutinesAlreadyApplied = applied.includes(GLOBAL_ROUTINES_SCHEMA_VERSION);
    const taskMergerModelLaneAlreadyApplied = applied.includes(TASK_MERGER_MODEL_LANE_VERSION);
    const bulkCompletionRefusalAtAlreadyApplied = applied.includes(BULK_COMPLETION_REFUSAL_AT_VERSION);
    const taskProposalClaimAlreadyApplied = applied.includes(TASK_PROPOSAL_CLAIM_VERSION);
    const configurationRevisionsAlreadyApplied = applied.includes(CONFIGURATION_REVISIONS_VERSION);
    const ideationAlreadyApplied = applied.includes(IDEATION_SCHEMA_VERSION);
    const researchFeatureProvenanceAlreadyApplied = applied.includes(RESEARCH_FEATURE_PROVENANCE_VERSION);
    const taskVerificationRequestAlreadyApplied = applied.includes(TASK_VERIFICATION_REQUEST_VERSION);
    const symbolLocksAlreadyApplied = applied.includes(SYMBOL_LOCKS_SCHEMA_VERSION);
    const bigintCountersAlreadyApplied = applied.includes(BIGINT_COUNTERS_VERSION);
    const workflowIrPinAndLegacyAdoptionAlreadyApplied = applied.includes(WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION);
    assertBinaryNotOlderThanDatabase(applied);
    let schemaChanged = false;

    if (!baselineAlreadyApplied) {
      const baselineSql = await readBaselineMigrationSql();
      // The baseline contains multiple statements including CREATE SCHEMA, CREATE
      // TABLE, CREATE INDEX, and seed INSERTs. postgres.js executes a single
      // query string as one batch (simple query protocol when unparameterized).
      await tx.execute(sql.raw(baselineSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${INITIAL_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

  /*
   * FNXC:AutomationIsolation 2026-07-13-22:37:
   * A database that already recorded the initial PostgreSQL baseline must still receive project-scoped automation storage. Apply this version independently of 0000; ambiguous legacy ownership fails closed before any bound cron runner can silently omit those schedules.
   */
    if (!automationIsolationAlreadyApplied) {
      const migrationSql = await readFile(AUTOMATION_ISOLATION_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${AUTOMATION_ISOLATION_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:AnalyticsIsolation 2026-07-14-00:05:
    Existing PostgreSQL databases that already recorded 0001 must independently receive analytics project partitions before project-scoped readers and writers start. Keep 0002 versioned so a fresh baseline cannot hide a skipped upgrade path.
    */
    if (!analyticsIsolationAlreadyApplied) {
      const migrationSql = await readFile(ANALYTICS_ISOLATION_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${ANALYTICS_ISOLATION_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:CommandCenterTenantIsolation 2026-07-14-01:04:
    Version 0003 supplies durable ownership for monitor and approval analytics. It must run independently after 0002 so databases that already accepted the earlier analytics migration cannot silently skip the remaining tenant partitions.
    */
    if (!monitorApprovalIsolationAlreadyApplied) {
      const migrationSql = await readFile(MONITOR_APPROVAL_ISOLATION_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:PostgresMigrationCompleteness 2026-07-14-09:27:
    Apply retired-table preservation independently of 0000 so an older partial migration target can retry without losing board, project-auth, or task-reviewer rows. The DDL is additive and idempotent.
    */
    if (!legacyCutoverPreservationAlreadyApplied) {
      const migrationSql = await readFile(LEGACY_CUTOVER_PRESERVATION_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:PostgresMultiProjectCutover 2026-07-14-11:18:
    Existing targets may already contain one completed project plus a partially copied second project. Apply metadata partitioning and collision-safe revision identity before any retry builds its migration plan.
    */
    if (!multiProjectCutoverAlreadyApplied) {
      const migrationSql = await readFile(MULTI_PROJECT_CUTOVER_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${MULTI_PROJECT_CUTOVER_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

  // Run plugin schema-init hooks regardless of whether the baseline was just
  // applied or already present — plugin tables must exist on every connection
  // the applier touches. The hooks are themselves idempotent (CREATE TABLE IF
  // NOT EXISTS), so re-running is safe.
    const pluginHooks = options.pluginHooks ?? DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS;
    await runPluginSchemaInitHooks(tx, pluginHooks);

    /*
    FNXC:ProjectDataIsolation 2026-07-14-12:10:
    Run universal ownership once, after plugin hooks, so first application covers core and plugin tables without duplicate DDL. Later boots validate that every newly introduced plugin table declared the same ownership contract instead of rebuilding primary keys, foreign keys, and policies on every startup.

    FNXC:ProjectArchiveIsolation 2026-07-14-14:31:
    The steady-state audit includes archive.archived_tasks because archived task IDs are project-local and must retain the same forced-RLS boundary as live task rows.
    */
    if (!projectOwnershipAlreadyApplied) {
      const projectOwnershipSql = await readFile(PROJECT_OWNERSHIP_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(projectOwnershipSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${PROJECT_OWNERSHIP_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    } else {
      const ownershipGaps = (await tx.execute(sql`
        SELECT n.nspname || '.' || c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN information_schema.columns col
          ON col.table_schema = n.nspname
         AND col.table_name = c.relname
         AND col.column_name = 'project_id'
        WHERE (n.nspname = 'project' OR (n.nspname = 'archive' AND c.relname = 'archived_tasks'))
          AND c.relkind = 'r'
          AND (
            col.column_name IS NULL
            OR NOT c.relrowsecurity
            OR NOT c.relforcerowsecurity
            OR NOT EXISTS (
              SELECT 1 FROM pg_policy p
              WHERE p.polrelid = c.oid AND p.polname = 'fusion_project_isolation'
            )
          )
        ORDER BY c.relname
      `)) as unknown as Array<{ table_name: string }>;
      if (ownershipGaps.length > 0) {
        throw new Error(
          `Project-owned tables are missing required isolation: ${ownershipGaps.map(({ table_name }) => table_name).join(", ")}`,
        );
      }
      const relationalGaps = (await tx.execute(sql`
        SELECT c.conrelid::regclass::text AS object_name, c.conname AS detail
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE (n.nspname = 'project' OR (n.nspname = 'archive' AND t.relname = 'archived_tasks'))
          AND c.contype IN ('p', 'u')
          AND NOT EXISTS (
            SELECT 1 FROM unnest(c.conkey) key_attnum
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_attnum
            WHERE a.attname = 'project_id'
          )
        UNION ALL
        SELECT t.oid::regclass::text, idx.relname
        FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'project' AND i.indisunique
          AND NOT EXISTS (
            SELECT 1 FROM unnest(i.indkey::smallint[]) key_attnum
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_attnum
            WHERE a.attname = 'project_id'
          )
        UNION ALL
        SELECT c.conrelid::regclass::text, c.conname
        FROM pg_constraint c
        JOIN pg_class child ON child.oid = c.conrelid
        JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
        JOIN pg_class parent ON parent.oid = c.confrelid
        JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
        WHERE c.contype = 'f' AND child_ns.nspname = 'project' AND parent_ns.nspname = 'project'
          AND (
            NOT EXISTS (
              SELECT 1 FROM unnest(c.conkey) key_attnum
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_attnum
              WHERE a.attname = 'project_id'
            ) OR NOT EXISTS (
              SELECT 1 FROM unnest(c.confkey) key_attnum
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = key_attnum
              WHERE a.attname = 'project_id'
            )
          )
        ORDER BY 1, 2
      `)) as unknown as Array<{ object_name: string; detail: string }>;
      if (relationalGaps.length > 0) {
        throw new Error(
          `Project-owned keys or relationships are globally scoped: ${relationalGaps.map(({ object_name, detail }) => `${object_name}.${detail}`).join(", ")}`,
        );
      }
    }

    /*
    FNXC:PostgresMigrationColumnCoverage 2026-07-14-13:17:
    Apply SQLite schema parity independently of the original baseline and ownership migration. Existing partial cutover targets must gain all late source columns before the idempotent migration retry rebuilds its table plan.
    */
    if (!sqliteSchemaParityAlreadyApplied) {
      const sqliteSchemaParitySql = await readFile(SQLITE_SCHEMA_PARITY_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(sqliteSchemaParitySql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${SQLITE_SCHEMA_PARITY_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:PlannerOversight 2026-07-14-18:49:
    Apply session_advisor_enabled independently of 0007 so databases that already
    recorded SQLite schema parity still gain the per-task session-advisor column
    before TaskStore/Drizzle SELECT paths run on boot.
    */
    if (!sessionAdvisorEnabledAlreadyApplied) {
      const sessionAdvisorEnabledSql = await readFile(SESSION_ADVISOR_ENABLED_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(sessionAdvisorEnabledSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${SESSION_ADVISOR_ENABLED_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:MissionFixIdempotency 2026-07-14-18:55:
    Existing PostgreSQL databases receive the validator-run lineage uniqueness invariant independently of earlier schema versions. Duplicate historical rows fail the migration visibly instead of being silently discarded.

    FNXC:PostgresConflictResolution 2026-07-14-20:52:
    Main assigned migration 0008 to session-advisor state before the cutover landed, so mission lineage uniqueness advances to 0009. Both migrations must run in order; sharing a bookkeeping version would silently skip one invariant.
    */
    if (!missionFixIdempotencyAlreadyApplied) {
      const migrationSql = await readFile(MISSION_FIX_IDEMPOTENCY_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${MISSION_FIX_IDEMPOTENCY_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:GitHubImportTranslate 2026-07-15-09:30:
    Create the import-translation cache table independently of earlier schema versions so existing databases gain it on boot before any Import Tasks translate/import read runs against it.
    */
    if (!importTranslationCacheAlreadyApplied) {
      const importTranslationCacheSql = await readFile(IMPORT_TRANSLATION_CACHE_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(importTranslationCacheSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${IMPORT_TRANSLATION_CACHE_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:MultiProjectIsolation 2026-07-15-23:40:
    Apply the owner_project_id domain/partition split independently of earlier
    schema versions so existing databases gain the domain column (backfilled from
    the previously conflated partition value) before any store read/write path
    that now targets owner_project_id runs on boot.
    */
    if (!ownerProjectIdSplitAlreadyApplied) {
      const ownerProjectIdSplitSql = await readFile(OWNER_PROJECT_ID_SPLIT_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(ownerProjectIdSplitSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${OWNER_PROJECT_ID_SPLIT_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:ChatPinned 2026-07-16-12:30:
    Apply the pin timestamp separately from the baseline so all pre-existing
    databases can safely read and write Direct chat pins after this rollout.
    */
    if (!chatSessionPinsAlreadyApplied) {
      const chatSessionPinsSql = await readFile(CHAT_SESSION_PINS_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(chatSessionPinsSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${CHAT_SESSION_PINS_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    if (!executorToolFailureRetryAlreadyApplied) {
      const executorToolFailureRetrySql = await readFile(EXECUTOR_TOOL_FAILURE_RETRY_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(executorToolFailureRetrySql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${EXECUTOR_TOOL_FAILURE_RETRY_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    if (!executorEscalationAttemptAlreadyApplied) {
      const executorEscalationAttemptSql = await readFile(EXECUTOR_ESCALATION_ATTEMPT_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(executorEscalationAttemptSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${EXECUTOR_ESCALATION_ATTEMPT_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    if (!globalRoutinesAlreadyApplied) {
      const migrationSql = await readFile(GLOBAL_ROUTINES_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${GLOBAL_ROUTINES_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }
    if (!taskMergerModelLaneAlreadyApplied) {
      const migrationSql = await readFile(TASK_MERGER_MODEL_LANE_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${TASK_MERGER_MODEL_LANE_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }
    /*
    FNXC:Lifecycle 2026-07-16-22:35:
    FN-8141 bulk-completion-refusal taint marker. PR #2260 added the column to
    the model + 0000 baseline but no forward migration, so existing clusters
    (baseline marker already present) never gained it and crashed on the first
    TaskStore SELECT. Apply it as a forward migration so those clusters recover.
    */
    if (!bulkCompletionRefusalAtAlreadyApplied) {
      const migrationSql = await readFile(BULK_COMPLETION_REFUSAL_AT_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${BULK_COMPLETION_REFUSAL_AT_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    if (!taskProposalClaimAlreadyApplied) {
      const migrationSql = await readFile(TASK_PROPOSAL_CLAIM_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${TASK_PROPOSAL_CLAIM_VERSION}) ON CONFLICT (version) DO NOTHING`);
      schemaChanged = true;
    }

    /*
    FNXC:GitHubImportTranslate 2026-07-16-23:30:
    0010's marker prevents its corrected fresh-install definition from running
    on upgrades. Apply 0016 separately before runtime cache reads so existing
    rows, RLS, and unbound compatibility stores share one partition contract.
    */
    /*
    FNXC:ConfigVersioning 2026-07-18-00:00:
    Migrations are explicitly registered rather than discovered. Keep 0021's
    bookkeeping check adjacent to its apply block so upgrades cannot silently
    omit configuration history while fresh installs appear healthy.
    */
    if (!configurationRevisionsAlreadyApplied) {
      const migrationSql = await readFile(CONFIGURATION_REVISIONS_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${CONFIGURATION_REVISIONS_VERSION}) ON CONFLICT (version) DO NOTHING`);
      schemaChanged = true;
    }

    /*
    FNXC:Ideation 2026-07-30-15:30:
    Register the ideation migration explicitly. New SQL files are never auto-discovered,
    and upgrades must receive project-scoped session/candidate tables before the store opens.
    */
    if (!ideationAlreadyApplied) {
      const migrationSql = await readFile(IDEATION_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${IDEATION_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`);
      schemaChanged = true;
    }

    if (!researchFeatureProvenanceAlreadyApplied) {
      const migrationSql = await readFile(RESEARCH_FEATURE_PROVENANCE_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${RESEARCH_FEATURE_PROVENANCE_VERSION}) ON CONFLICT (version) DO NOTHING`);
      schemaChanged = true;
    }

    if (!importTranslationCacheScopeFixAlreadyApplied) {
      const migrationSql = await readFile(IMPORT_TRANSLATION_CACHE_SCOPE_FIX_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    if (!taskVerificationRequestAlreadyApplied) {
      const migrationSql = await readFile(TASK_VERIFICATION_REQUEST_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${TASK_VERIFICATION_REQUEST_VERSION}) ON CONFLICT (version) DO NOTHING`);
      schemaChanged = true;
    }

    /*
    FNXC:SymbolLock 2026-07-30-14:10:
    Migration files are manually registered. Apply 0025 independently so both
    fresh and upgraded installations gain forced RLS after 0006 owns its setup.
    */
    if (!symbolLocksAlreadyApplied) {
      const migrationSql = await readFile(SYMBOL_LOCKS_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${SYMBOL_LOCKS_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`);
      schemaChanged = true;
    }

    if (!importTranslationCacheLegacyPartitionBackfillAlreadyApplied) {
      const migrationSql = await readFile(IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:PostgresBigintCounters 2026-07-18-21:45:
    Existing embedded-PG clusters that were created before this migration still have
    integer columns for unbounded token/usage counters, so the SQLite migrator fails on
    values larger than int4. Apply the column type widening after ownership/parity and
    record the version so fresh baselines already benefit from the bigint DDL.
    */
    if (!bigintCountersAlreadyApplied) {
      const bigintCountersSql = await readFile(BIGINT_COUNTERS_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(bigintCountersSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${BIGINT_COUNTERS_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }
    /*
    FNXC:WorkflowIrPin 2026-07-19-03:10 (U9b / KTD-3 + KTD-8):
    Migration files are manually registered — a .sql that is not wired through a version
    constant AND an apply block here silently never runs. Apply 0027 independently of the
    baseline so databases that already recorded 0000 gain the IR-pin and adoption columns;
    without the forward migration those clusters crash on the first slim TaskStore SELECT.
    */
    if (!workflowIrPinAndLegacyAdoptionAlreadyApplied) {
      const migrationSql = await readFile(WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION}) ON CONFLICT (version) DO NOTHING`);
      schemaChanged = true;
    }

    return { applied: schemaChanged, pluginHooksRun: pluginHooks.length };
  });
}

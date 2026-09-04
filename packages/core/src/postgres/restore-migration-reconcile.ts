/**
 * Reconcile public.fusion_schema_migrations after a project/archive restore.
 *
 * FNXC:PostgresBackup 2026-09-04-05:12:
 * Paired dumps replace `project`, `archive`, and `central` only. Restoring an
 * older dump therefore drops later CREATE-TABLE relations while leaving the
 * current binary's versions in `public.fusion_schema_migrations`. Startup then
 * skips those migrations and later inserts fail. After every project restore,
 * rewind numeric ledger rows from the earliest missing CREATE-TABLE sentinel
 * (not only 0040) and replay `applySchemaBaseline` so restored schemas and
 * bookkeeping match.
 *
 * FNXC:PostgresBackup 2026-09-04-05:12:
 * Postgres.js 3.4.9 defaults `ssl` to false and does not honor libpq `sslmode`
 * in the URL. Remote reconciliation connections must pass `ssl: "verify-full"`.
 * Loopback/embedded hosts keep SSL off because the bundled cluster has no TLS.
 */
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { parsePgUrl } from "./pg-backup.js";
import {
  applySchemaBaseline,
  CHAT_SESSION_TAGS_VERSION,
  CONFIGURATION_REVISIONS_VERSION,
  GITHUB_CHECK_STATES_VERSION,
  AGENT_ACTIVITY_EVENTS_VERSION,
  IDEATION_SCHEMA_VERSION,
  IMPORT_TRANSLATION_CACHE_VERSION,
  LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION,
  MEMORY_RECALL_RECORDS_VERSION,
  MIGRATION_BOOKKEEPING_TABLE,
  MISSION_LINEAGE_STOP_VERSION,
  PATCHNODE_ENTRIES_VERSION,
  SPEC_LOCK_DRIFT_REPORT_VERSION,
  TASK_LIFECYCLE_CONSUMERS_VERSION,
  TASK_LIFECYCLE_OUTBOX_VERSION,
  UNPLANNED_EXECUTION_BLOCK_DEDUPE_VERSION,
  WORKSPACE_COORDINATION_LEASES_SCHEMA_VERSION,
} from "./schema-applier.js";

export interface RestoreMigrationCatalog {
  relationExists(qualifiedName: string): Promise<boolean>;
  unstampNumericVersionsFrom(version: string): Promise<void>;
  replayPendingMigrations(): Promise<void>;
}

export interface RestoredSchemaRelationSentinel {
  readonly version: string;
  readonly relations: readonly string[];
}

const INITIAL_SCHEMA_VERSION = "0000";

/**
 * CREATE-TABLE sentinels used to detect a restored schema that is older than
 * the recorded ledger. Checked in version order; the first miss is the rewind floor.
 * Central-schema tables are excluded: project dumps do not replace `central`.
 */
export const RESTORED_SCHEMA_RELATION_SENTINELS: readonly RestoredSchemaRelationSentinel[] = [
  { version: INITIAL_SCHEMA_VERSION, relations: ["project.tasks"] },
  { version: LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION, relations: ["project.boards"] },
  { version: IMPORT_TRANSLATION_CACHE_VERSION, relations: ["project.import_translation_cache"] },
  { version: CONFIGURATION_REVISIONS_VERSION, relations: ["project.configuration_revisions"] },
  { version: IDEATION_SCHEMA_VERSION, relations: ["project.ideation_sessions"] },
  { version: MISSION_LINEAGE_STOP_VERSION, relations: ["project.mission_lineage_stops"] },
  { version: CHAT_SESSION_TAGS_VERSION, relations: ["project.chat_tags"] },
  {
    version: TASK_LIFECYCLE_OUTBOX_VERSION,
    relations: ["project.task_lifecycle_events", "project.task_lifecycle_event_seq"],
  },
  {
    version: TASK_LIFECYCLE_CONSUMERS_VERSION,
    relations: ["project.task_lifecycle_consumer_registrations"],
  },
  { version: UNPLANNED_EXECUTION_BLOCK_DEDUPE_VERSION, relations: ["project.unplanned_execution_blocks"] },
  { version: GITHUB_CHECK_STATES_VERSION, relations: ["project.github_check_states"] },
  { version: AGENT_ACTIVITY_EVENTS_VERSION, relations: ["project.agent_activity_events"] },
  { version: SPEC_LOCK_DRIFT_REPORT_VERSION, relations: ["project.spec_locks"] },
  { version: MEMORY_RECALL_RECORDS_VERSION, relations: ["project.memory_recall_records"] },
  {
    version: WORKSPACE_COORDINATION_LEASES_SCHEMA_VERSION,
    relations: ["project.workspace_coordination_leases"],
  },
  { version: PATCHNODE_ENTRIES_VERSION, relations: ["project.patchnode_entries"] },
];

export async function reconcileRestoredSchemaMigrations(
  catalog: RestoreMigrationCatalog,
): Promise<{ rewoundFrom: string | null }> {
  let rewoundFrom: string | null = null;
  for (const sentinel of RESTORED_SCHEMA_RELATION_SENTINELS) {
    for (const relation of sentinel.relations) {
      if (await catalog.relationExists(relation)) continue;
      rewoundFrom = sentinel.version;
      break;
    }
    if (rewoundFrom) break;
  }
  if (rewoundFrom) await catalog.unstampNumericVersionsFrom(rewoundFrom);
  await catalog.replayPendingMigrations();
  return { rewoundFrom };
}

export function createDrizzleRestoreMigrationCatalog(
  db: PostgresJsDatabase<Record<string, never>>,
): RestoreMigrationCatalog {
  return {
    async relationExists(qualifiedName) {
      const rows = (await db.execute(
        sql`SELECT to_regclass(${qualifiedName}) AS rel`,
      )) as unknown as Array<{ rel: string | null }>;
      return rows[0]?.rel != null;
    },
    async unstampNumericVersionsFrom(version) {
      const floor = Number.parseInt(version, 10);
      if (!Number.isFinite(floor)) {
        throw new Error(`Invalid migration version for restore rewind: ${version}`);
      }
      await db.execute(sql.raw(`
        CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
          version text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `));
      await db.execute(sql.raw(`
        DELETE FROM public.${MIGRATION_BOOKKEEPING_TABLE}
        WHERE version ~ '^[0-9]+$' AND CAST(version AS integer) >= ${floor}
      `));
    },
    async replayPendingMigrations() {
      await applySchemaBaseline(db);
    },
  };
}

/**
 * FNXC:PostgresBackup 2026-09-04-05:12:
 * Embedded/loopback clusters have no TLS. Any other host is treated as remote
 * and must use certificate verification; postgres.js will not infer this from
 * a URL `sslmode` query parameter.
 */
export function reconciliationPostgresSsl(connectionString: string): false | "verify-full" {
  const host = (parsePgUrl(connectionString).host ?? "").toLowerCase();
  if (
    host === "" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("/")
  ) {
    return false;
  }
  return "verify-full";
}

export async function reconcileRestoredSchemaMigrationsFromUrl(
  connectionString: string,
): Promise<{ rewoundFrom: string | null }> {
  const client = postgres(connectionString, {
    max: 1,
    connect_timeout: 10,
    prepare: false,
    ssl: reconciliationPostgresSsl(connectionString),
  });
  try {
    const db = drizzle(client);
    return await reconcileRestoredSchemaMigrations(createDrizzleRestoreMigrationCatalog(db));
  } finally {
    await client.end({ timeout: 5 });
  }
}

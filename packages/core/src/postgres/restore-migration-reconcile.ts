/**
 * Reconcile public.fusion_schema_migrations after a project/archive restore.
 *
 * FNXC:PostgresBackup 2026-09-04-04:42:
 * Paired dumps replace `project`, `archive`, and `central` only. Restoring a
 * dump taken before migration 0040 therefore drops `project.task_lifecycle_events`
 * and `project.task_lifecycle_event_seq` while leaving the current binary's
 * versions in `public.fusion_schema_migrations`. Startup then skips 0040 and
 * later task deletion/archival inserts fail. After every project restore, rewind
 * numeric ledger rows from the earliest missing sentinel relation and replay
 * `applySchemaBaseline` so restored schemas and bookkeeping match.
 */
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import {
  applySchemaBaseline,
  MIGRATION_BOOKKEEPING_TABLE,
  TASK_LIFECYCLE_CONSUMERS_VERSION,
  TASK_LIFECYCLE_OUTBOX_VERSION,
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

/**
 * CREATE-TABLE sentinels used to detect a restored schema that is older than
 * the recorded ledger. Checked in version order; the first miss is the rewind floor.
 */
export const RESTORED_SCHEMA_RELATION_SENTINELS: readonly RestoredSchemaRelationSentinel[] = [
  {
    version: TASK_LIFECYCLE_OUTBOX_VERSION,
    relations: ["project.task_lifecycle_events", "project.task_lifecycle_event_seq"],
  },
  {
    version: TASK_LIFECYCLE_CONSUMERS_VERSION,
    relations: ["project.task_lifecycle_consumer_registrations"],
  },
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

export async function reconcileRestoredSchemaMigrationsFromUrl(
  connectionString: string,
): Promise<{ rewoundFrom: string | null }> {
  const client = postgres(connectionString, {
    max: 1,
    connect_timeout: 10,
    prepare: false,
  });
  try {
    const db = drizzle(client);
    return await reconcileRestoredSchemaMigrations(createDrizzleRestoreMigrationCatalog(db));
  } finally {
    await client.end({ timeout: 5 });
  }
}

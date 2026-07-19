import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type AdvisoryLockTransaction = Pick<PostgresJsDatabase<Record<string, never>>, "execute">;

/**
 * FNXC:PostgresLockOrdering 2026-07-18-17:12:
 * Serialize schema DDL behind any active SQLite cutover transaction.
 *
 * SQLite migration takes `fusion:sqlite-migration-state` before it reads the
 * target schema. Schema application and runtime plugin DDL must take the same
 * lock first, then their narrower schema lock, so PostgreSQL never sees the
 * inverse DDL/read lock order that can deadlock concurrent project startup.
 */
export async function acquireSqliteMigrationStateLock(tx: AdvisoryLockTransaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('fusion:sqlite-migration-state'))`);
}

export async function acquireSchemaMutationLocks(tx: AdvisoryLockTransaction): Promise<void> {
  await acquireSqliteMigrationStateLock(tx);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('fusion:schema-applier'))`);
}

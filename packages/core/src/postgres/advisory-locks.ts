import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type AdvisoryLockTransaction = Pick<PostgresJsDatabase<Record<string, never>>, "execute">;

/**
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

import postgres from "postgres";
import { looksLikePoolerUrl } from "./backend-resolver.js";

export class PlanningLifecycleLockTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningLifecycleLockTransportError";
  }
}

export const DEFAULT_PLANNING_LIFECYCLE_LOCK_TIMEOUT_MS = 5_000;

type DedicatedPostgresClient = ReturnType<typeof postgres>;
type PlanningLifecycleLockInput = {
  projectId: string;
  taskId: string;
  directSessionUrl: string | null;
  provenance: "embedded-lifecycle" | "migration-override" | "runtime-direct" | null;
  runtimeUrl?: string | null;
  migrationUrl?: string | null;
  timeoutMs?: number;
  onLockAcquisitionAttempt?: () => void;
};

/** Side-effect-free structural check shared by the lineage degrade path and lock acquisition. */
export function planningLifecycleLockTransportAvailability(input: Pick<PlanningLifecycleLockInput, "directSessionUrl" | "provenance" | "runtimeUrl" | "migrationUrl">): { available: true } | { available: false; reason: string } {
  const directUrl = input.directSessionUrl;
  if (!directUrl || !input.provenance || looksLikePoolerUrl(directUrl)) return { available: false, reason: "direct-session-unavailable" };
  let directDatabase: string;
  try { directDatabase = decodeURIComponent(new URL(directUrl).pathname.replace(/^\//, "")); } catch { return { available: false, reason: "direct-session-invalid" }; }
  if (!directDatabase) return { available: false, reason: "direct-session-database-missing" };
  const descriptorEndpoint = input.provenance === "embedded-lifecycle" || input.provenance === "runtime-direct" ? input.runtimeUrl : input.migrationUrl;
  if (!descriptorEndpoint || descriptorEndpoint !== directUrl) return { available: false, reason: "backend-descriptor-mismatch" };
  const operationalUrl = input.runtimeUrl ?? input.migrationUrl;
  if (operationalUrl) {
    try {
      const operationalDatabase = decodeURIComponent(new URL(operationalUrl).pathname.replace(/^\//, ""));
      if (!operationalDatabase || operationalDatabase !== directDatabase) return { available: false, reason: "backend-database-mismatch" };
    } catch { return { available: false, reason: "backend-endpoint-invalid" }; }
  }
  return { available: true };
}

const planningLifecycleLockKey = (projectId: string, taskId: string): string => `fusion:planning-lifecycle:${projectId}:${taskId}`;
type PostgresBackendIdentity = {
  database: string;
  host: string | null;
  port: number | null;
  cluster: string | null;
};

async function readPostgresBackendIdentity(client: DedicatedPostgresClient): Promise<PostgresBackendIdentity[]> {
  return await client<PostgresBackendIdentity[]>`
    SELECT current_database() AS database,
           inet_server_addr()::text AS host,
           inet_server_port() AS port,
           current_setting('cluster_name', true) AS cluster
  `;
}

async function runBoundedTransportPhase<T>(
  client: DedicatedPostgresClient,
  timeoutMs: number,
  timeoutMessage: string,
  failureMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          void client.end({ timeout: 0 }).catch(() => undefined);
          reject(new PlanningLifecycleLockTransportError(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof PlanningLifecycleLockTransportError) throw error;
    // Do not retain the driver error as `cause`: connection failures can carry
    // endpoint credentials, while this error is operator-visible.
    throw new PlanningLifecycleLockTransportError(failureMessage);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * FNXC:PlanningDependencyReseed 2026-08-04-00:43:
 * Planning handoff and dependency re-seed cross processes, so their outer lock
 * is a dedicated PostgreSQL session rather than the TaskStore's local mutex.
 * Never use the runtime pool: a transaction pooler can change sessions between
 * lock and unlock and silently defeat session advisory locking.
 */
export async function withPlanningLifecycleAdvisoryLock<T>(
  input: PlanningLifecycleLockInput,
  callback: () => Promise<T>,
): Promise<T> {
  const availability = planningLifecycleLockTransportAvailability(input);
  if (!availability.available) {
    throw new PlanningLifecycleLockTransportError(`Planning lifecycle lock transport unavailable: ${availability.reason}`);
  }
  const directUrl = input.directSessionUrl!;
  const directDatabase = decodeURIComponent(new URL(directUrl).pathname.replace(/^\//, ""));
  const operationalUrl = input.runtimeUrl ?? input.migrationUrl;
  const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_PLANNING_LIFECYCLE_LOCK_TIMEOUT_MS);

  const client = postgres(directUrl, {
    max: 1,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1_000)),
    prepare: false,
    onnotice: () => {},
    debug: input.onLockAcquisitionAttempt
      ? (_connection, query) => {
          if (query.includes("pg_advisory_lock(")) input.onLockAcquisitionAttempt?.();
        }
      : undefined,
  });
  const key = planningLifecycleLockKey(input.projectId, input.taskId);
  let acquired = false;
  try {
    /*
    FNXC:PlanningDependencyReseed 2026-08-04-00:54:
    URL shape is not proof of the connected target. Verify the session-selected
    database before locking so an accidental migration endpoint cannot serialize
    one database while task writes target another.
    */
    const identity = await runBoundedTransportPhase(
      client,
      timeoutMs,
      `Planning lifecycle lock session setup timed out after ${timeoutMs}ms`,
      "Planning lifecycle lock could not establish its dedicated session",
      async () => {
        const rows = await readPostgresBackendIdentity(client);
        await client`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, false)`;
        return rows;
      },
    );
    if (identity[0]?.database !== directDatabase) {
      throw new PlanningLifecycleLockTransportError("Planning lifecycle lock session selected an unexpected database");
    }

    /*
    FNXC:PlanningDependencyReseed 2026-08-04-01:04:
    A database name identifies neither a PostgreSQL server nor an advisory-lock
    namespace. Compare the resolved operational connection's server identity
    with the dedicated direct session so a migration URL aimed at another
    cluster with the same database cannot serialize the wrong task lifecycle.
    */
    if (operationalUrl && operationalUrl !== directUrl) {
      const operationalClient = postgres(operationalUrl, {
        max: 1,
        connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1_000)),
        prepare: false,
        onnotice: () => {},
      });
      try {
        const operationalIdentity = await runBoundedTransportPhase(
          operationalClient,
          timeoutMs,
          `Planning lifecycle lock backend identity check timed out after ${timeoutMs}ms`,
          "Planning lifecycle lock could not verify the resolved backend server identity",
          () => readPostgresBackendIdentity(operationalClient),
        );
        const expected = operationalIdentity[0];
        const actual = identity[0];
        if (!expected || !actual
          || expected.database !== actual.database
          || expected.host !== actual.host
          || expected.port !== actual.port
          || (expected.cluster && actual.cluster && expected.cluster !== actual.cluster)) {
          throw new PlanningLifecycleLockTransportError("Planning lifecycle lock endpoint targets a different PostgreSQL server than the resolved backend");
        }
      } catch (error) {
        if (error instanceof PlanningLifecycleLockTransportError) throw error;
        throw new PlanningLifecycleLockTransportError("Planning lifecycle lock could not verify the resolved backend server identity");
      } finally {
        await operationalClient.end({ timeout: 5 }).catch(() => undefined);
      }
    }
    await runBoundedTransportPhase(
      client,
      timeoutMs,
      `Planning lifecycle lock acquisition timed out after ${timeoutMs}ms`,
      "Planning lifecycle lock acquisition failed",
      () => client`SELECT pg_advisory_lock(hashtext(${key}))`,
    );
    acquired = true;
    return await callback();
  } finally {
    try {
      if (acquired) {
        await runBoundedTransportPhase(
          client,
          timeoutMs,
          `Planning lifecycle lock cleanup timed out after ${timeoutMs}ms`,
          "Planning lifecycle lock cleanup failed",
          () => client`SELECT pg_advisory_unlock(hashtext(${key}))`,
        ).catch(() => undefined);
      }
    } finally {
      await client.end({ timeout: 5 }).catch(() => undefined);
    }
  }
}

/**
 * FNXC:SpecLockLineageInvalidation 2026-08-10-14:33:
 * Parent removal can affect many children, but no child may be cleared outside its planning lock.
 * Advisory locks are session-scoped, so this acquires every sorted task key on one dedicated session
 * instead of trading correctness for a fan-out cap or opening one connection per child.
 */
export async function withPlanningLifecycleAdvisoryLocks<T>(
  input: Omit<PlanningLifecycleLockInput, "taskId"> & { taskIds: readonly string[] },
  callback: () => Promise<T>,
): Promise<T> {
  const taskIds = [...new Set(input.taskIds)].sort();
  if (taskIds.length === 0) return callback();
  const availability = planningLifecycleLockTransportAvailability(input);
  if (!availability.available) throw new PlanningLifecycleLockTransportError(`Planning lifecycle lock transport unavailable: ${availability.reason}`);
  const directUrl = input.directSessionUrl!;
  const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_PLANNING_LIFECYCLE_LOCK_TIMEOUT_MS);
  const directDatabase = decodeURIComponent(new URL(directUrl).pathname.replace(/^\//, ""));
  const operationalUrl = input.runtimeUrl ?? input.migrationUrl;
  const client = postgres(directUrl, {
    max: 1, connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1_000)), prepare: false, onnotice: () => {},
    debug: input.onLockAcquisitionAttempt ? (_connection, query) => { if (query.includes("pg_advisory_lock(")) input.onLockAcquisitionAttempt?.(); } : undefined,
  });
  const keys = taskIds.map((taskId) => planningLifecycleLockKey(input.projectId, taskId));
  const acquired: string[] = [];
  try {
    const identity = await runBoundedTransportPhase(client, timeoutMs, `Planning lifecycle lock session setup timed out after ${timeoutMs}ms`, "Planning lifecycle lock could not establish its dedicated session", async () => {
      const rows = await readPostgresBackendIdentity(client);
      await client`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, false)`;
      return rows;
    });
    if (identity[0]?.database !== directDatabase) throw new PlanningLifecycleLockTransportError("Planning lifecycle lock session selected an unexpected database");

    /*
    FNXC:SpecLockLineageInvalidation 2026-08-10-14:47:
    The multi-key session must prove the same resolved backend identity as the single-key lock.
    Matching advisory key strings on a different PostgreSQL server would serialize nothing.
    */
    if (operationalUrl && operationalUrl !== directUrl) {
      const operationalClient = postgres(operationalUrl, {
        max: 1,
        connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1_000)),
        prepare: false,
        onnotice: () => {},
      });
      try {
        const operationalIdentity = await runBoundedTransportPhase(
          operationalClient,
          timeoutMs,
          `Planning lifecycle lock backend identity check timed out after ${timeoutMs}ms`,
          "Planning lifecycle lock could not verify the resolved backend server identity",
          () => readPostgresBackendIdentity(operationalClient),
        );
        const expected = operationalIdentity[0];
        const actual = identity[0];
        if (!expected || !actual
          || expected.database !== actual.database
          || expected.host !== actual.host
          || expected.port !== actual.port
          || (expected.cluster && actual.cluster && expected.cluster !== actual.cluster)) {
          throw new PlanningLifecycleLockTransportError("Planning lifecycle lock endpoint targets a different PostgreSQL server than the resolved backend");
        }
      } catch (error) {
        if (error instanceof PlanningLifecycleLockTransportError) throw error;
        throw new PlanningLifecycleLockTransportError("Planning lifecycle lock could not verify the resolved backend server identity");
      } finally {
        await operationalClient.end({ timeout: 5 }).catch(() => undefined);
      }
    }
    for (const key of keys) {
      await runBoundedTransportPhase(client, timeoutMs, `Planning lifecycle lock acquisition timed out after ${timeoutMs}ms`, "Planning lifecycle lock acquisition failed", () => client`SELECT pg_advisory_lock(hashtext(${key}))`);
      acquired.push(key);
    }
    return await callback();
  } finally {
    for (const key of acquired.reverse()) await runBoundedTransportPhase(client, timeoutMs, `Planning lifecycle lock cleanup timed out after ${timeoutMs}ms`, "Planning lifecycle lock cleanup failed", () => client`SELECT pg_advisory_unlock(hashtext(${key}))`).catch(() => undefined);
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

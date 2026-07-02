/**
 * PostgreSQL connection management.
 *
 * FNXC:PostgresConnection 2026-06-24-01:55:
 * Manages the Drizzle connection pool backed by postgres.js, with the
 * DATABASE_MIGRATION_URL split for pooled runtime connections.
 *
 * Two connections may exist:
 *   1. Runtime pool — serves all normal queries. Uses DATABASE_URL (or the
 *      embedded lifecycle's resolved URL). May be a pooled/pooler connection.
 *   2. Migration connection — a direct (non-pooled) connection for schema work
 *      (DDL, migrations). Uses DATABASE_MIGRATION_URL when set, else the runtime
 *      URL. Always `prepare: false` so it works under transaction poolers.
 *
 * When the runtime URL is a transaction pooler and no migration URL is set,
 * runtime prepared statements are disabled automatically and a warning is
 * emitted (VAL-CONN-008). When a migration URL is set, runtime keeps prepared
 * statements enabled (the migration URL handles the DDL).
 *
 * The runtime pool disables prepared statements if the URL looks like a pooler,
 * because a pooler in transaction mode cannot safely cache prepared statements
 * across connections.
 */

import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLogger } from "../logger.js";
import {
  resolveBackend,
  type ResolvedBackend,
  looksLikePoolerUrl,
  poolerWarning,
  describeBackendForLog,
} from "./backend-resolver.js";
import { redactCredentialsFromMessage, redactConnectionString } from "./credential-redact.js";

const log = createLogger("postgres-connection");

/**
 * FNXC:PostgresConnection 2026-06-24-01:55:
 * Connection pool sizing. A small default pool is used for the runtime
 * connection since Fusion's workload is primarily short transactional queries.
 * The embedded mode may use an even smaller pool. These can be tuned via
 * environment variables if needed.
 */
const DEFAULT_POOL_MAX = 10;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 20;

/** Schema type placeholder until the Drizzle schema (U3) is defined. */
type AnySchema = Record<string, never>;

/**
 * Options for creating the connection manager. Allows tests to override env
 * without mutating process.env.
 */
export interface CreateConnectionOptions {
  readonly backend?: ResolvedBackend;
  readonly poolMax?: number;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly onWarning?: (message: string) => void;
}

/** A live PostgreSQL connection set with runtime + migration Drizzle instances. */
export interface PostgresConnections {
  /** Drizzle instance for runtime queries (may use a pooled connection). */
  readonly runtime: PostgresJsDatabase<AnySchema>;
  /**
   * Drizzle instance for schema/migration work (direct connection, no pooler).
   * May be the same underlying connection as runtime when no migration URL split
   * is configured.
   */
  readonly migration: PostgresJsDatabase<AnySchema>;
  /** The resolved backend descriptor. */
  readonly backend: ResolvedBackend;
  /** Close all underlying connections. */
  close(): Promise<void>;
  /** Run a health-check query against the runtime connection. */
  ping(): Promise<void>;
}

/**
 * Error thrown when the database connection fails at startup.
 *
 * FNXC:PostgresConnection 2026-06-24-02:00:
 * Unreachable DATABASE_URL must produce a clear, actionable error and non-zero
 * exit (VAL-CONN-004). The error message redacts credentials so the password
 * is never exposed even in crash logs.
 */
export class DatabaseConnectionError extends Error {
  readonly cause: unknown;
  readonly safeUrl: string;

  constructor(url: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Cannot connect to PostgreSQL at ${redactConnectionString(url)}: ` +
        `${redactCredentialsFromMessage(reason)}`,
    );
    this.name = "DatabaseConnectionError";
    this.cause = cause;
    this.safeUrl = redactConnectionString(url);
  }
}

/**
 * Create the PostgreSQL connection set from environment variables.
 *
 * Resolves the backend, creates the runtime and migration postgres.js
 * connections, wraps them in Drizzle, and verifies connectivity.
 *
 * Throws `DatabaseConnectionError` (with redacted credentials) if the initial
 * connection probe fails — the caller should exit non-zero.
 *
 * In embedded mode (DATABASE_URL unset), this throws because the connection
 * URL is not yet known — the embedded lifecycle feature must start Postgres
 * first and then call `createConnectionSetFromUrl` with the resolved URL.
 */
export async function createConnectionSet(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateConnectionOptions = {},
): Promise<PostgresConnections> {
  const backend = options.backend ?? resolveBackend(env);

  if (backend.mode === "embedded") {
    // Embedded mode: the URL is provided by the embedded lifecycle (U2).
    // This connection layer does not start the embedded instance itself.
    throw new Error(
      "Cannot create a connection set in embedded mode without a resolved URL. " +
        "The embedded lifecycle (DATABASE_URL unset) must start Postgres first " +
        "and provide the connection URL via createConnectionSetFromUrl().",
    );
  }

  // External mode requires a runtime URL.
  if (!backend.runtimeUrl) {
    throw new Error(
      "External backend resolved but runtimeUrl is null. This is an internal error.",
    );
  }

  return createConnectionSetFromUrl(backend, options);
}

/**
 * Create the connection set from an already-resolved backend (used by the
 * embedded lifecycle after it starts the bundled Postgres).
 */
export async function createConnectionSetFromUrl(
  backend: ResolvedBackend,
  options: CreateConnectionOptions = {},
): Promise<PostgresConnections> {
  const poolMax = options.poolMax ?? DEFAULT_POOL_MAX;
  const connectTimeout = options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
  const idleTimeout = options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  const onWarning = options.onWarning ?? ((msg: string) => log.warn(msg));

  // Log the resolved backend (password redacted).
  log.log(describeBackendForLog(backend));

  // Emit pooler warning if applicable (VAL-CONN-008).
  const warning = poolerWarning(backend);
  if (warning) {
    onWarning(warning);
  }

  // FNXC:PostgresCutover 2026-06-27-10:35:
  // Multi-project isolation warning: when using an external DATABASE_URL,
  // schema names (project/central/archive) are fixed. Two projects pointing
  // at the same DATABASE_URL will share the same schemas, causing cross-project
  // data leakage. The embedded mode avoids this (one PG per ~/.fusion/ dir).
  if (backend.mode === "external") {
    onWarning(
      "WARNING: External DATABASE_URL shares fixed schema names (project/central/archive). " +
      "Two projects pointing at the same DATABASE_URL will share data. " +
      "Use a distinct database per project for isolation."
    );
  }

  const runtimeUrl = backend.runtimeUrl;
  if (!runtimeUrl) {
    throw new Error(
      "Cannot create connection set: backend.runtimeUrl is null. " +
        "Ensure the embedded lifecycle has provided a URL or DATABASE_URL is set.",
    );
  }

  // Determine whether to use prepared statements in the runtime pool.
  // Disable when the URL is a pooler and no migration URL split is configured.
  const runtimeIsPooler = looksLikePoolerUrl(runtimeUrl);
  const runtimePrepare = backend.migrationUrlOverridden ? true : !runtimeIsPooler;

  const runtimeSql = postgres(runtimeUrl, {
    max: poolMax,
    connect_timeout: connectTimeout,
    idle_timeout: idleTimeout,
    prepare: runtimePrepare,
    // Suppress the default onnotice (which logs to console.log) to avoid
    // leaking connection-parameter notices that might contain sensitive info.
    onnotice: () => {},
  });
  const runtimeDb = drizzle(runtimeSql);

  // Migration connection: use DATABASE_MIGRATION_URL if set, else runtime URL.
  // Always prepare: false for migration work (DDL under a pooler must not use
  // prepared statements).
  const migrationUrl = backend.migrationUrl ?? runtimeUrl;
  const migrationIsSameUrl = migrationUrl === runtimeUrl;
  let migrationSql: ReturnType<typeof postgres>;
  let migrationDb: PostgresJsDatabase<AnySchema>;

  if (migrationIsSameUrl && runtimePrepare) {
    // Reuse the runtime connection when there's no split and prepared statements
    // are safe. This avoids opening a second pool unnecessarily.
    migrationSql = runtimeSql;
    migrationDb = runtimeDb;
  } else {
    migrationSql = postgres(migrationUrl, {
      max: 1, // Migration work is serial; a single direct connection suffices.
      connect_timeout: connectTimeout,
      idle_timeout: idleTimeout,
      prepare: false,
      onnotice: () => {},
    });
    migrationDb = drizzle(migrationSql);
  }

  const connections: PostgresConnections = {
    runtime: runtimeDb,
    migration: migrationDb,
    backend,
    async close() {
      // Always close the migration connection first if it's separate.
      const closePromises: Promise<unknown>[] = [];
      if (migrationSql !== runtimeSql) {
        closePromises.push(migrationSql.end({ timeout: 5 }));
      }
      closePromises.push(runtimeSql.end({ timeout: 5 }));
      await Promise.allSettled(closePromises);
    },
    async ping() {
      // Simple connectivity probe.
      await runtimeSql`SELECT 1`;
    },
  };

  return connections;
}

/**
 * Verify that a connection URL is reachable. Used as a startup precondition
 * (VAL-CONN-004: unreachable DATABASE_URL fails loudly).
 *
 * Throws `DatabaseConnectionError` with redacted credentials on failure.
 */
export async function verifyConnection(
  url: string,
  timeoutSeconds = DEFAULT_CONNECT_TIMEOUT_SECONDS,
): Promise<void> {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: timeoutSeconds,
    idle_timeout: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await sql`SELECT 1`;
  } catch (error) {
    throw new DatabaseConnectionError(url, error);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export { redactConnectionString };

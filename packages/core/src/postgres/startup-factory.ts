/**
 * Runtime startup factory: construct a PostgreSQL-backed TaskStore.
 *
 * FNXC:RuntimeStartupWiring 2026-06-26-14:00:
 * This is the single startup entry point that production construction sites
 * (engine InProcessRuntime, dashboard project-store-resolver, CLI serve/
 * dashboard commands, desktop local-server/local-runtime) use to boot
 * PostgreSQL.
 *
 * The factory encapsulates the five-step backend boot sequence so individual
 * call sites do not each re-implement backend resolution, connection opening,
 * schema application, AsyncDataLayer construction, and dual-read harness
 * integration. The factory always returns a ready {@link BackendBootResult}
 * or throws an actionable startup error.
 *
 * Resolution rules (matching the mission architecture):
 *   - DATABASE_URL set (external mode): connect to the external PostgreSQL
 *     server, apply the schema baseline, construct the AsyncDataLayer. Returns
 *     a backend boot result.
 *   - DATABASE_URL unset (embedded mode): start the bundled embedded
 *     PostgreSQL, then proceed like external mode against the embedded URL.
 *     This is the DEFAULT production path — embedded PG is the zero-config
 *     backend, mirroring the zero-config SQLite experience it replaces.
 *   - DATABASE_URL unset AND FUSION_NO_EMBEDDED_PG=1: reject the obsolete
 *     configuration. SQLite files are accepted only as migration inputs.
 *
 * FNXC:BackendFlip 2026-06-26-14:05:
 * The default backend was flipped from SQLite to embedded PostgreSQL in this
 * change (feature flip-embedded-pg-default, cutover milestone). Previously
 * embedded PG required an explicit opt-in via FUSION_EMBEDDED_PG=1; now it is
 * the default. FUSION_EMBEDDED_PG=1 is still honored as a no-op alias for backward
 * compatibility (it cannot force embedded when DATABASE_URL is set, since
 * external mode always wins). The flip is safe because the embedded-postgres
 * platform binaries are now bundled for macOS/Linux/Windows (arm64/x64) and
 * the boot smoke has been updated to exercise the embedded path by default
 * with an initdb-aware health-check timeout.
 */

import { join, resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { isValidSqliteDatabaseFile } from "../sqlite-validation.js";
import { createLogger } from "../logger.js";
import { TaskStore } from "../store.js";
import {
  resolveBackend,
  resolveBackendWithOptions,
  describeBackendForLog,
  type ResolvedBackend,
} from "./backend-resolver.js";
import {
  createConnectionSet,
  createConnectionSetFromUrl,
  type PostgresConnections,
} from "./connection.js";
import { applySchemaBaseline, MIGRATION_BOOKKEEPING_TABLE } from "./schema-applier.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createAsyncDataLayer, type AsyncDataLayer } from "./data-layer.js";
import {
  invalidateEmbeddedRuntimeUrl,
  registerEmbeddedRuntimeUrl,
  releaseEmbeddedRuntimeLease,
  type EmbeddedRuntimeLease,
} from "./active-backend-registry.js";
import { runLoadedPluginSchemaInitHooks, type LoadedPluginSchemaContract } from "./plugin-schema-hook.js";
import {
  lookupRegisteredProjectIdByPath,
  ProjectPartitionRekeyError,
  rekeyFallbackProjectPartition,
  selectDegradedBindTarget,
  stampMigratedProjectRows,
} from "./migration-stamping.js";

// FNXC:RuntimeStartupWiring 2026-06-24-10:55:
// The embedded PostgreSQL lifecycle module imports the `embedded-postgres`
// package, which uses dynamic import() for platform-specific binaries
// (@embedded-postgres/linux-x64, etc.). Importing it statically would pull
// those unresolved dynamic imports into the CLI bundle (tsup/esbuild bundles
// @fusion/* with noExternal), breaking the build on platforms whose optional
// binary is absent. The embedded lifecycle is therefore loaded LAZILY via
// await import() only when embedded PG is actually used at runtime
// (DATABASE_URL unset AND FUSION_NO_EMBEDDED_PG not set — the default since
// the flip-embedded-pg-default change). The external (DATABASE_URL) and
// legacy SQLite-opt-out paths never touch it.
type EmbeddedLifecycleLike = {
  start(): Promise<ResolvedBackend>;
  stop(): Promise<void>;
  getOwnsProcess(): boolean;
};

const log = createLogger("startup-factory");

/*
FNXC:PostgresSchema 2026-07-17-23:55:
Schema-backend failures were reported via err.message alone. Drizzle wraps
query failures in DrizzleQueryError, whose message is "Failed query: <full
SQL> params: ..." — for the schema baseline that is thousands of SQL lines
— while the REAL PostgresError lives in err.cause and was dropped. Field
reports (Windows desktop boot failures) were undiagnosable because every
surfaced log was query text with no error message. Walk the cause chain and
truncate giant messages so the actual failure always survives into the log.
*/
function describeErrorChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    parts.push(
      message.length > 1200 ? `${message.slice(0, 600)} … [truncated] … ${message.slice(-300)}` : message,
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" ⇐ caused by: ");
}

/**
 * FNXC:ProjectDataIsolation 2026-07-14-12:10:
 * An unregistered project still needs a stable, non-shared PostgreSQL partition. Derive a deterministic identity from its canonical root path so first-boot migration and every later runtime session select the same isolated rows without inventing cross-project ownership.
 */
function fallbackProjectIdForRoot(rootDir: string): string {
  return `local-${createHash("sha256").update(resolve(rootDir)).digest("hex").slice(0, 24)}`;
}

/**
 * FNXC:BackendFlip 2026-06-26-14:10:
 * Legacy opt-in environment variable for the bundled embedded PostgreSQL.
 * Since the default-flip (flip-embedded-pg-default), embedded PG is on by
 * default when DATABASE_URL is unset, so this variable is now a no-op alias
 * kept for backward compatibility with scripts/docs that still set it. It
 * cannot force embedded mode when DATABASE_URL is set (external always wins).
 */
export const EMBEDDED_PG_ENV = "FUSION_EMBEDDED_PG";

/**
 * FNXC:BackendFlip 2026-06-26-14:10:
 * Retired SQLite opt-out variable. It remains parseable so startup can return
 * a clear migration error instead of silently ignoring stale operator config.
 */
export const NO_EMBEDDED_PG_ENV = "FUSION_NO_EMBEDDED_PG";

/** Explicit process-level opt-in for starting Fusion against its test database. */
export const TEST_MODE_ENV = "FUSION_TEST_MODE";
/** External PostgreSQL target used only while Fusion test mode is active. */
export const TEST_DATABASE_URL_ENV = "FUSION_TEST_DATABASE_URL";
/** Optional direct migration target paired with FUSION_TEST_DATABASE_URL. */
export const TEST_DATABASE_MIGRATION_URL_ENV = "FUSION_TEST_DATABASE_MIGRATION_URL";

function isTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Return true when the embedded PostgreSQL backend should be used in embedded
 * mode (DATABASE_URL unset).
 *
 * FNXC:BackendFlip 2026-06-26-14:15:
 * Post default-flip, embedded PG is the DEFAULT in embedded mode. The legacy
 * FUSION_EMBEDDED_PG opt-in is a no-op. A false result identifies obsolete
 * opt-out configuration that the startup factory rejects.
 *
 * A retired opt-out value is detected so startup can reject it with a clear
 * migration message. Everything else uses embedded PostgreSQL by default.
 *
 * @returns true when embedded PG should be used (the default); false when the
 *          operator explicitly opted out via FUSION_NO_EMBEDDED_PG=1.
 */
export function isEmbeddedPgRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isEmbeddedPgOptedOut(env);
}

/**
 * FNXC:BackendFlip 2026-06-26-14:15:
 * Detect obsolete FUSION_NO_EMBEDDED_PG configuration for diagnostics.
 */
export function isEmbeddedPgOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env[NO_EMBEDDED_PG_ENV]);
}

/**
 * The result of a successful PostgreSQL backend boot. The caller uses
 * `.taskStore` as the runtime store and must call `.shutdown()` during
 * process teardown to release the connection pool and (if started) stop the
 * embedded PostgreSQL process.
 */
export interface BackendBootResult {
  /** The PostgreSQL-backed TaskStore (constructed with an AsyncDataLayer). */
  readonly taskStore: TaskStore;
  /** The resolved backend descriptor (embedded or external). */
  readonly backend: ResolvedBackend;
  /** The constructed AsyncDataLayer (also reachable via taskStore.getAsyncLayer()). */
  readonly asyncLayer: AsyncDataLayer;
  /**
   * Release all backend resources: close the TaskStore (which closes the
   * AsyncDataLayer / connection pool) and stop the embedded PostgreSQL
   * process if one was started. Best-effort; errors are logged, not thrown.
   */
  shutdown(): Promise<void>;
  /**
   * FNXC:DesktopClosePolicy 2026-07-18-06:00:
   * Close the TaskStore/pools and release the runtime lease but LEAVE an
   * embedded postmaster running (disarming its process shutdown hook), for the
   * desktop "leave PostgreSQL running" quit choice. No-op difference from
   * shutdown() on external backends.
   */
  detachKeepingEmbedded(): Promise<void>;
}

/** PostgreSQL resources used by CentralCore before a project TaskStore exists. */
export interface CentralBackendLayerResult {
  readonly backend: ResolvedBackend;
  readonly asyncLayer: AsyncDataLayer;
  releaseConnections(): Promise<void>;
  shutdown(): Promise<void>;
}

interface SchemaBackendBootResult {
  readonly backend: ResolvedBackend;
  readonly connections: PostgresConnections;
  readonly embeddedLifecycle: EmbeddedLifecycleLike | null;
  readonly embeddedRuntimeLease: EmbeddedRuntimeLease | null;
  readonly embeddedRuntimeUrl: string | null;
  readonly embeddedOwnsProcess: boolean;
}

/**
 * FNXC:PostgresBackup 2026-07-16-12:40:
 * stop() only stops a postmaster owned by this lifecycle. Consequently owner
 * teardown burns the URL generation for every joiner, while joiner teardown
 * releases only its opaque lease. This keeps synchronous backup resolution
 * aligned with physical cluster liveness without logging the credential URL.
 */
async function stopEmbeddedRuntime(
  lifecycle: EmbeddedLifecycleLike | null,
  lease: EmbeddedRuntimeLease | null,
  runtimeUrl: string | null,
  ownsProcess: boolean,
): Promise<void> {
  try {
    await lifecycle?.stop();
  } finally {
    if (lease && runtimeUrl) {
      if (ownsProcess) {
        invalidateEmbeddedRuntimeUrl(runtimeUrl, lease);
      } else {
        releaseEmbeddedRuntimeLease(lease);
      }
    }
  }
}

/**
 * FNXC:PostgresStartupLifecycle 2026-07-14-19:18:
 * Central-registry and project-store startup must share one backend-resolution,
 * embedded-lifecycle, administrative-connection, and schema-baseline path.
 * Callers retain ownership of the returned resources and may replace the
 * administrative pool with an RLS-bound runtime pool after migration.
 */
/*
FNXC:PostgresEmbedded 2026-07-18-01:10:
Issue #2286 auto-recovery. An embedded cluster initdb'd by an earlier version
on a non-UTF-8 OS locale (WIN1252/WIN1254) rejects the UTF-8 schema SQL with
`character ... has no equivalent in encoding`. Such a cluster can NEVER have
completed a boot: the whole baseline runs in one transaction whose query
string fails encoding conversion before execution, so no schema was applied
and the SQLite auto-migration (which runs after schema boot) never moved any
data. Deleting the data dir and re-initdb'ing (now forced UTF-8) is therefore
lossless — but only when proven, so recovery requires ALL of:
  1. embedded mode (Fusion owns the data dir),
  2. the encoding-conversion error signature,
  3. the live cluster confirming a non-UTF-8 server_encoding,
  4. zero tables in project/central/archive and no recorded migration
     versions (the never-successfully-booted state),
  5. this process owns the postmaster (never delete under a foreign owner).
One retry only; a second failure surfaces the manual re-init hint.
*/
class NonUtf8EmbeddedClusterError extends Error {
  constructor(readonly dataDir: string, override readonly cause: unknown) {
    super(`embedded cluster at ${dataDir} has a non-UTF-8 encoding and is empty; auto re-initializing`);
  }
}

/*
FNXC:PostgresStartupRace 2026-07-20-22:10:
Companion to embedded-lifecycle.ts's FNXC:PostgresStartupRace 2026-07-15-20:45
note: isAlreadyRunning() joins a data dir optimistically off postmaster.pid
without probing liveness (a stale pid file from a crash must still resolve to
a port, by design), and ensureJoinedDatabase() is explicitly best-effort —
"never convert an optimistic join into a hard startup failure". But nothing
downstream actually retried: a joiner that raced the true owner's TCP bind
(process started, postmaster.pid written and "database system is ready"
logged, but the listener not yet accepting) got exactly one shot at
createConnectionSetFromUrl(), which throws ECONNREFUSED, which
bootSchemaBackendOnce turns into a hard `startup-factory: failed to
initialize PostgreSQL schema backend` error — observed reproducibly via
`pnpm smoke:boot`'s isolated embedded-instance boot. This class marks that
one specific case (joined instance, i.e. embeddedOwnsProcess === false,
connection-refused) as retryable, mirroring the existing
NonUtf8EmbeddedClusterError one-retry pattern below.
*/
class JoinedInstanceUnreachableError extends Error {
  constructor(override readonly cause: unknown) {
    super("embedded postgres: joined instance was not yet accepting connections");
  }
}

/** Matches a TCP-level connection-refused failure (ECONNREFUSED / "connect ECONNREFUSED"). */
function isConnectionRefusedError(chainText: string): boolean {
  return /ECONNREFUSED/i.test(chainText);
}

/** Matches PostgreSQL's encoding-conversion failure raised by a non-UTF-8 cluster. */
export function isEncodingConversionError(chainText: string): boolean {
  return /has no equivalent in encoding/i.test(chainText);
}

/**
 * Prove the cluster is in the recoverable state: non-UTF-8 server encoding AND
 * no applied schema (no tables in Fusion's schemas, no migration versions).
 * Any query failure means "not proven" — the caller keeps the original error.
 */
async function isEmptyNonUtf8Cluster(db: PostgresJsDatabase<Record<string, never>>): Promise<boolean> {
  const encodingRows = (await db.execute(
    sql`SELECT current_setting('server_encoding') AS encoding`,
  )) as unknown as Array<{ encoding: string }>;
  const encoding = (encodingRows[0]?.encoding ?? "").toUpperCase();
  if (encoding === "UTF8" || encoding === "") return false;

  const tableRows = (await db.execute(sql`
    SELECT count(*)::int AS tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('project', 'central', 'archive') AND c.relkind = 'r'
  `)) as unknown as Array<{ tables: number }>;
  if ((tableRows[0]?.tables ?? 1) !== 0) return false;

  const versionRows = (await db.execute(sql`
    SELECT count(*)::int AS versions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ${MIGRATION_BOOKKEEPING_TABLE} AND c.relkind = 'r'
  `)) as unknown as Array<{ versions: number }>;
  if ((versionRows[0]?.versions ?? 0) !== 0) {
    const applied = (await db.execute(sql.raw(
      `SELECT count(*)::int AS applied FROM public.${MIGRATION_BOOKKEEPING_TABLE}`,
    ))) as unknown as Array<{ applied: number }>;
    if ((applied[0]?.applied ?? 1) !== 0) return false;
  }
  return true;
}

async function bootSchemaBackend(
  options: Pick<CreateTaskStoreForBackendOptions, "env" | "backend" | "embeddedPgRequested" | "embeddedDataDir" | "poolMax" | "globalSettingsDir">,
  bypassProjectIsolation = false,
): Promise<SchemaBackendBootResult> {
  try {
    return await bootSchemaBackendOnce(options, bypassProjectIsolation);
  } catch (error) {
    if (error instanceof JoinedInstanceUnreachableError) {
      log.warn(
        "startup-factory: joined embedded postgres instance was not yet accepting connections " +
          "(startup race with the true owner's TCP bind — see FNXC:PostgresStartupRace 2026-07-20-22:10). " +
          "Retrying once after a short delay.",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      return await bootSchemaBackendOnce(options, bypassProjectIsolation);
    }
    if (!(error instanceof NonUtf8EmbeddedClusterError)) throw error;
    log.warn(
      `startup-factory: embedded cluster at ${error.dataDir} was created with a non-UTF-8 OS-locale ` +
        `encoding by an earlier version and never completed a boot (issue #2286). ` +
        `Re-initializing it as UTF-8 and retrying once.`,
    );
    rmSync(error.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return await bootSchemaBackendOnce(options, bypassProjectIsolation);
  }
}

async function bootSchemaBackendOnce(
  options: Pick<CreateTaskStoreForBackendOptions, "env" | "backend" | "embeddedPgRequested" | "embeddedDataDir" | "poolMax" | "globalSettingsDir">,
  bypassProjectIsolation = false,
): Promise<SchemaBackendBootResult> {
  const env = options.env ?? process.env;
  const backend = options.backend ?? resolveBackend(env);
  const embeddedRequested = options.embeddedPgRequested ?? isEmbeddedPgRequested(env);
  if (backend.mode === "embedded" && !embeddedRequested) {
    throw new Error(
      "The SQLite opt-out has been removed. Unset FUSION_NO_EMBEDDED_PG and use embedded PostgreSQL, or configure DATABASE_URL.",
    );
  }

  let embeddedLifecycle: EmbeddedLifecycleLike | null = null;
  let embeddedRuntimeLease: EmbeddedRuntimeLease | null = null;
  let embeddedRuntimeUrl: string | null = null;
  let embeddedOwnsProcess = false;
  let resolvedBackend = backend;
  let embeddedDataDir: string | null = null;
  if (backend.mode === "embedded") {
    const { EmbeddedPostgresLifecycle, defaultEmbeddedDataDir, DEFAULT_EMBEDDED_DATABASE } =
      await import("./embedded-lifecycle.js");
    const { GlobalSettingsStore } = await import("../global-settings.js");
    // Tests that boot an embedded backend intentionally do not have an
    // operator global-settings directory. Production always reads the shared
    // global preference before it starts the server.
    const configuredMaxConnections = process.env.VITEST === "true" && !options.globalSettingsDir
      ? undefined
      : (await new GlobalSettingsStore(options.globalSettingsDir).getSettings()).embeddedPostgresMaxConnections;
    const maxConnections = Number.isInteger(configuredMaxConnections)
      ? Math.min(2_000, Math.max(32, configuredMaxConnections!))
      : 500;
    const dataDir = resolve(options.embeddedDataDir ?? defaultEmbeddedDataDir());
    embeddedDataDir = dataDir;
    log.log(`startup-factory: starting embedded PostgreSQL (data dir ${dataDir})`);
    embeddedLifecycle = new EmbeddedPostgresLifecycle({
      dataDir,
      database: DEFAULT_EMBEDDED_DATABASE,
      postgresFlags: ["-c", `max_connections=${maxConnections}`],
      onLog: (message) => log.log(message),
      onError: (error) => log.error(String(error)),
    });
    try {
      resolvedBackend = await embeddedLifecycle.start();
      if (resolvedBackend.runtimeUrl) {
        embeddedRuntimeUrl = resolvedBackend.runtimeUrl;
        embeddedOwnsProcess = embeddedLifecycle.getOwnsProcess();
        embeddedRuntimeLease = registerEmbeddedRuntimeUrl(embeddedRuntimeUrl, {
          ownsProcess: embeddedOwnsProcess,
        });
      }
    } catch (error) {
      await embeddedLifecycle.stop().catch(() => undefined);
      throw new Error(
        `startup-factory: failed to start embedded PostgreSQL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // FNXC:PostgresTuiLogging 2026-07-15-14:52: Do not repeat routine embedded
  // backend resolution in the TUI; external backend details remain useful
  // operator diagnostics and are logged with credentials redacted.
  if (resolvedBackend.mode === "external") {
    log.log(describeBackendForLog(resolvedBackend));
  }
  let connections: PostgresConnections | undefined;
  try {
    connections = resolvedBackend.mode === "external"
      ? await createConnectionSet(env, {
          backend: resolvedBackend,
          poolMax: options.poolMax,
          bypassProjectIsolation,
        })
      : await createConnectionSetFromUrl(resolvedBackend, {
          poolMax: options.poolMax,
          bypassProjectIsolation,
        });
    await applySchemaBaseline(connections.migration);
    return {
      backend: resolvedBackend,
      connections,
      embeddedLifecycle,
      embeddedRuntimeLease,
      embeddedRuntimeUrl,
      embeddedOwnsProcess,
    };
  } catch (error) {
    /*
    FNXC:PostgresEmbedded 2026-07-18-01:10:
    Classify the #2286 non-UTF-8-cluster state while the connection is still
    open (the proof queries need it), then tear down before signalling the
    retry wrapper. Never recover a joined instance (embeddedOwnsProcess false):
    deleting a data dir under a foreign postmaster is not ours to do.
    */
    let recoverable = false;
    if (
      embeddedLifecycle !== null &&
      embeddedOwnsProcess &&
      connections !== undefined &&
      embeddedDataDir !== null &&
      isEncodingConversionError(error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error))
    ) {
      recoverable = await isEmptyNonUtf8Cluster(connections.migration).catch(() => false);
    }
    /*
    FNXC:PostgresStartupRace 2026-07-20-22:10:
    A joined (not owned) embedded instance that fails with a connection-refused
    is the documented startup race (embedded-lifecycle.ts FNXC:PostgresStartupRace
    2026-07-15-20:45): we joined off postmaster.pid before the true owner's
    listener was accepting connections. This is retryable — see bootSchemaBackend's
    JoinedInstanceUnreachableError handling — rather than a hard failure.
    */
    const joinedConnectionRefused =
      embeddedLifecycle !== null &&
      !embeddedOwnsProcess &&
      isConnectionRefusedError(error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error));
    await connections?.close().catch(() => undefined);
    await stopEmbeddedRuntime(
      embeddedLifecycle,
      embeddedRuntimeLease,
      embeddedRuntimeUrl,
      embeddedOwnsProcess,
    ).catch(() => undefined);
    if (recoverable && embeddedDataDir !== null) {
      throw new NonUtf8EmbeddedClusterError(embeddedDataDir, error);
    }
    if (joinedConnectionRefused) {
      throw new JoinedInstanceUnreachableError(error);
    }
    throw error;
  }
}

export interface StartupDatabaseOptions {
  readonly testDatabaseMode: boolean;
  readonly backend: ResolvedBackend;
  readonly embeddedDataDir?: string;
}

/**
 * Resolve the database target before any schema, registry, or project write.
 *
 * Test mode is a storage boundary, not only a model-selection flag. A persisted
 * global `testMode: true` (or FUSION_TEST_MODE=1) therefore ignores the normal
 * DATABASE_URL. Operators may provide FUSION_TEST_DATABASE_URL for a dedicated
 * external database; otherwise Fusion uses a separate embedded cluster under
 * `<global settings>/embedded-postgres/test`.
 *
 * An explicit `backend` or `embeddedDataDir` remains authoritative for focused
 * tests and programmatic embeddings.
 */
export async function resolveStartupDatabaseOptions(
  options: Pick<CreateTaskStoreForBackendOptions, "env" | "backend" | "embeddedDataDir" | "globalSettingsDir"> = {},
): Promise<StartupDatabaseOptions> {
  const env = options.env ?? process.env;
  let globalTestMode = false;

  // Vitest callers without a threaded temp global dir intentionally avoid the
  // real operator settings file. Production and callers with an explicit dir
  // can safely read the file-backed bootstrap setting before PostgreSQL opens.
  const runningVitest = process.env.VITEST === "true";
  if (options.globalSettingsDir || !runningVitest) {
    const { GlobalSettingsStore } = await import("../global-settings.js");
    globalTestMode = (await new GlobalSettingsStore(options.globalSettingsDir).getSettings()).testMode === true;
  }

  const testDatabaseMode = isTruthyEnvValue(env[TEST_MODE_ENV]) || globalTestMode;
  if (!testDatabaseMode) {
    return {
      testDatabaseMode: false,
      backend: options.backend ?? resolveBackend(env),
      ...(options.embeddedDataDir ? { embeddedDataDir: options.embeddedDataDir } : {}),
    };
  }

  const backend = options.backend ?? resolveBackendWithOptions({
    databaseUrl: env[TEST_DATABASE_URL_ENV] ?? null,
    databaseMigrationUrl: env[TEST_DATABASE_MIGRATION_URL_ENV] ?? null,
  });
  if (backend.mode === "external") {
    return {
      testDatabaseMode: true,
      backend,
      ...(options.embeddedDataDir ? { embeddedDataDir: options.embeddedDataDir } : {}),
    };
  }

  let globalDir = options.globalSettingsDir;
  if (!globalDir) {
    const { resolveGlobalDir } = await import("../global-settings.js");
    globalDir = resolveGlobalDir();
  }
  return {
    testDatabaseMode: true,
    backend,
    embeddedDataDir: options.embeddedDataDir ?? join(globalDir, "embedded-postgres", "test"),
  };
}

/**
 * Open an unscoped PostgreSQL layer for the central project/node registry.
 *
 * FNXC:CentralPostgresCutover 2026-07-14-17:12:
 * CentralCore is used by project discovery and node commands before any
 * project-scoped TaskStore exists. It therefore needs a first-class backend
 * bootstrap that applies the shared schema without inventing a project root or
 * constructing a dead SQLite CentralDatabase. Embedded instances are reused by
 * the lifecycle registry, while each caller owns only its connection pool.
 */
export async function createCentralBackendLayer(
  options: Pick<CreateTaskStoreForBackendOptions, "env" | "backend" | "embeddedPgRequested" | "embeddedDataDir" | "poolMax" | "globalSettingsDir"> = {},
): Promise<CentralBackendLayerResult> {
  const databaseOptions = await resolveStartupDatabaseOptions(options);
  const boot = await bootSchemaBackend({
    ...options,
    backend: databaseOptions.backend,
    ...(databaseOptions.embeddedDataDir ? { embeddedDataDir: databaseOptions.embeddedDataDir } : {}),
  }, true);
  const {
    backend: resolvedBackend,
    connections,
    embeddedLifecycle,
    embeddedRuntimeLease,
    embeddedRuntimeUrl,
    embeddedOwnsProcess,
  } = boot;
  try {
    /*
    FNXC:CentralPostgresCutover 2026-07-14-19:06:
    Central-only startup must import and verify fusion-central.db before exposing the registry layer. Project startup is not guaranteed to run first, so deferring this source made legacy projects and nodes appear missing from PostgreSQL-only commands.
    */
    let globalDir = options.globalSettingsDir;
    if (!globalDir) {
      const { resolveGlobalDir } = await import("../global-settings.js");
      globalDir = resolveGlobalDir();
    }
    const legacyCentralPath = join(globalDir, "fusion-central.db");
    const {
      CENTRAL_SQLITE_MIGRATION_KEY,
      formatMigrationProgress,
      isSqliteMigrationComplete,
      migrateSqliteToPostgres,
    } = await import("./sqlite-migrator.js");
    const centralMigrationComplete = await isSqliteMigrationComplete(
      connections.migration,
      CENTRAL_SQLITE_MIGRATION_KEY,
    );
    if (!databaseOptions.testDatabaseMode && !centralMigrationComplete && existsSync(legacyCentralPath) && isValidSqliteDatabaseFile(legacyCentralPath)) {
      const report = await migrateSqliteToPostgres(connections.migration, [{
        sqlitePath: legacyCentralPath,
        pgSchema: "central",
      }], {
        skipBaseline: true,
        migrationKey: CENTRAL_SQLITE_MIGRATION_KEY,
        onProgress: (event) => log.log(`central startup: SQLite migration — ${formatMigrationProgress(event)}`),
      });
      const failures = report.tables.filter((table) => !table.skipped && !table.verified);
      if (failures.length > 0) {
        throw new Error(`${failures.length} central table(s) failed verification: ${failures.map((table) => table.table).join(", ")}`);
      }
    }
    const asyncLayer = createAsyncDataLayer(connections);
    let connectionsReleased = false;
    const releaseConnections = async (): Promise<void> => {
      if (connectionsReleased) return;
      connectionsReleased = true;
      await asyncLayer.close().catch(() => undefined);
    };
    return {
      backend: resolvedBackend,
      asyncLayer,
      releaseConnections,
      async shutdown(): Promise<void> {
        await releaseConnections();
        await stopEmbeddedRuntime(
          embeddedLifecycle,
          embeddedRuntimeLease,
          embeddedRuntimeUrl,
          embeddedOwnsProcess,
        ).catch(() => undefined);
      },
    };
  } catch (error) {
    await connections.close().catch(() => undefined);
    await stopEmbeddedRuntime(
      embeddedLifecycle,
      embeddedRuntimeLease,
      embeddedRuntimeUrl,
      embeddedOwnsProcess,
    ).catch(() => undefined);
    throw error;
  }
}

/**
 * Options for {@link createTaskStoreForBackend}.
 */
export interface CreateTaskStoreForBackendOptions {
  /**
   * The project working directory (rootDir) the TaskStore is scoped to. This
   * is the same value a legacy `new TaskStore(rootDir)` call would receive.
   * Required when `projectId` is omitted; ignored when `projectId` is set
   * (the project context is resolved from the central registry instead).
   */
  readonly rootDir?: string;
  /** Optional global settings directory (forwarded to the TaskStore constructor). */
  readonly globalSettingsDir?: string;
  /** Environment record (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Override the resolved backend (tests). When omitted, the backend is
   * resolved from the environment via resolveBackend().
   */
  readonly backend?: ResolvedBackend;
  /**
   * Override the embedded-PG decision (tests). When omitted, the decision is
   * read from the environment. Pass `true` to force embedded in tests;
   * `false` exercises the retired-opt-out error path.
   */
  readonly embeddedPgRequested?: boolean;
  /**
   * Override the embedded data directory (tests). Defaults to
   * defaultEmbeddedDataDir().
   */
  readonly embeddedDataDir?: string;
  /**
   * Connection pool sizing override (forwarded to createConnectionSet).
   */
  readonly poolMax?: number;
  /**
   * The project ID, forwarded to TaskStore.getOrCreateForProject when set.
   * When omitted, the factory constructs the TaskStore directly via the
   * constructor (matching `new TaskStore(rootDir)`).
   */
  readonly projectId?: string;
  /*
  FNXC:MigrationHoldingPage 2026-07-17-12:20:
  During the one-time SQLite→PostgreSQL auto-migration the caller's HTTP server is
  not yet listening, so the CLI binds a temporary holding server on the dashboard
  port and needs the structured migration progress stream to surface it in the
  browser. This observer receives the same MigrationProgressEvent stream that is
  logged to the terminal; it must never throw (fire-and-forget UI plumbing).
  */
  readonly onMigrationProgress?: (event: import("./sqlite-migrator.js").MigrationProgressEvent) => void;
}

/**
 * Decide whether the factory should attempt a PostgreSQL boot for the given
 * environment. PostgreSQL is the only runtime backend, so this compatibility
 * probe always returns true.
 *
 * Exposed so call sites can cheaply check "should I even try PostgreSQL?"
 * before awaiting the full factory (which opens connections).
 */
export function shouldUsePostgresBackend(
  _env: NodeJS.ProcessEnv = process.env,
  _opts: { embeddedPgRequested?: boolean } = {},
): boolean {
  /*
   * FNXC:PostgresFinalCutover 2026-07-14-17:08:
   * PostgreSQL is the only runtime backend after the final migration. Keep this
   * compatibility probe deterministic so old callers cannot interpret an
   * obsolete environment flag as permission to construct a SQLite TaskStore.
   */
  return true;
}

/**
 * Construct a PostgreSQL-backed TaskStore for the current environment.
 *
 * FNXC:BackendFlip 2026-06-26-14:20:
 * Post default-flip, the sequence is:
 *   1. Resolve the backend (external via DATABASE_URL, or embedded when unset).
 *   2. Reject the retired SQLite opt-out in embedded mode.
 *   3. For external mode: open connections via createConnectionSet.
 *   4. For embedded mode: start the EmbeddedPostgresLifecycle, then open
 *      connections via createConnectionSetFromUrl with the resolved URL.
 *   5. Apply the schema baseline to the migration connection (idempotent).
 *   6. Construct the AsyncDataLayer from the connection set.
 *   7. Construct the TaskStore with the AsyncDataLayer (backend mode).
 *   8. Integrate the dual-read harness when FUSION_DUAL_READ=1. The harness
 *      is held by the result's shutdown path; the runtime-*-async features
 *      consult it for write routing.
 *
 * Credential safety: connection errors are wrapped in DatabaseConnectionError
 * which redacts the password (VAL-CONN-004, VAL-CONN-005). The resolved
 * backend is logged via describeBackendForLog (password redacted).
 *
 * @returns the mandatory PostgreSQL backend boot result.
 */
export async function createTaskStoreForBackend(
  options: CreateTaskStoreForBackendOptions,
): Promise<BackendBootResult> {
  const env = options.env ?? process.env;
  const databaseOptions = await resolveStartupDatabaseOptions(options);
  const backend = databaseOptions.backend;
  const effectiveOptions: CreateTaskStoreForBackendOptions = {
    ...options,
    backend,
    ...(databaseOptions.embeddedDataDir ? { embeddedDataDir: databaseOptions.embeddedDataDir } : {}),
  };
  const embeddedRequested = options.embeddedPgRequested ?? isEmbeddedPgRequested(env);

  /*
   * FNXC:PostgresFinalCutover 2026-07-14-17:08:
   * The SQLite runtime and its Database implementation have been removed, so
   * the historical opt-out must fail explicitly. Returning null here caused
   * dozens of callers to construct a non-functional TaskStore and split the
   * central registry away from PostgreSQL. External DATABASE_URL always wins;
   * the obsolete flag is only rejected when it would have selected SQLite.
   */
  if (backend.mode === "embedded" && !embeddedRequested) {
    throw new Error(
      "The SQLite opt-out has been removed. Unset FUSION_NO_EMBEDDED_PG and use embedded PostgreSQL, or configure DATABASE_URL.",
    );
  }

  // When constructing via the constructor (no projectId), rootDir is required.
  if (!options.projectId && !options.rootDir) {
    throw new Error(
      "createTaskStoreForBackend: rootDir is required when projectId is not provided",
    );
  }
  const rootDir = options.rootDir ?? "";

  /*
  FNXC:FasterStartup 2026-07-14-23:55:
  Factory substep timings feed CLI phase logs so operators can separate embedded
  PG start + schema work from engine bring-up. Cheap permanent diagnostics.
  */
  const factoryT0 = Date.now();
  let boot: SchemaBackendBootResult;
  try {
    const schemaT0 = Date.now();
    boot = await bootSchemaBackend(effectiveOptions);
    log.log(`startup phase backend.schemaBackend: ${Date.now() - schemaT0}ms`);
  } catch (err) {
    const chain = describeErrorChain(err);
    /*
    FNXC:PostgresEmbedded 2026-07-18-00:20:
    Issue #2286: a cluster initdb'd by an earlier version on a non-UTF-8 OS
    locale cannot store the UTF-8 schema SQL and cannot be converted in place.
    Newly created clusters are forced to UTF-8 (DEFAULT_EMBEDDED_INITDB_FLAGS);
    existing ones need a manual re-init, so say exactly that.
    */
    const encodingHint = /has no equivalent in encoding/i.test(chain)
      ? " HINT: this embedded PostgreSQL cluster was created with a non-UTF-8 encoding inherited from the OS locale by an earlier Fusion version. It cannot be converted in place — stop Fusion, delete the embedded data directory (default: ~/.fusion/embedded-postgres/default), and start again so the cluster is recreated as UTF-8."
      : "";
    throw new Error(
      `startup-factory: failed to initialize PostgreSQL schema backend: ${chain}${encodingHint}`,
    );
  }
  let { connections } = boot;
  const {
    backend: resolvedBackend,
    embeddedLifecycle,
    embeddedRuntimeLease,
    embeddedRuntimeUrl,
    embeddedOwnsProcess,
  } = boot;

  /*
  FNXC:PostgresMigration 2026-07-10:
  Step 5.5 — first-boot auto-migration from legacy SQLite. The pre-flip upgrade
  contract ("auto-migrate + keep the SQLite file as a backup") was documented
  below but never wired: an existing SQLite instance switched to the PG backend
  booted an EMPTY database with its data silently stranded in .fusion/fusion.db
  (the review-flagged data-loss trap). Guarded to run at most once per
  database: only when a valid legacy fusion.db exists at the project root AND
  the PG project.tasks table is still empty. Failure is LOUD (boot aborts) —
  silently continuing on an empty database is exactly the trap this exists to
  close. `fn db migrate` remains the manual/explicit path (dry-run, external
  URLs, partial sources).
  */
  // FNXC:PostgresMigrationBanner 2026-07-12: populated when Step 5.5 actually
  // migrated data; persisted into project settings after Step 7.
  let autoMigrationNotice:
    | { migratedAt: string; migratedRows: number; tables: number; sqliteBackups: string[] }
    | undefined;
  /*
  FNXC:CentralProjectIdentity 2026-07-13-22:00:
  Resolve the central-registry project id for a rootDir-booted store. Post
  de-cwd architecture: cwd/rootDir is ONLY a lookup key into central.projects;
  project IDENTITY (the partition key every task/config read and write is
  scoped by) comes from the registry. Before this, `fn dashboard` / `fn serve`
  booted their main store UNBOUND (rootDir only), so unscoped API requests
  read and wrote NULL-project_id rows on the shared embedded cluster while the
  projectId-bound engine could not see them. Returns undefined when the path
  is not registered (legacy/unregistered single-project setups stay unbound,
  matching their unfiltered readers).
  */
  // A test database starts clean by definition. Never seed it from the
  // operator's retained production SQLite files.
  if (rootDir && !databaseOptions.testDatabaseMode) {
    try {
      const fusionDir = join(rootDir, ".fusion");
      const legacySqlitePath = join(fusionDir, "fusion.db");
      const {
        migrateSqliteToPostgres,
        defaultMigrationSources,
        formatMigrationProgress,
        isSqliteMigrationComplete,
        completeSqliteMigration,
        recordSqliteMigrationComplete,
        CENTRAL_SQLITE_MIGRATION_KEY,
      } = await import("./sqlite-migrator.js");
      const fallbackProjectId = fallbackProjectIdForRoot(rootDir);
      let migrationProjectId = options.projectId
        ?? (await lookupRegisteredProjectIdByPath(connections.migration, rootDir))
        ?? fallbackProjectId;
      let migrationKey = `project:${migrationProjectId}`;
      let migrationComplete = await isSqliteMigrationComplete(connections.migration, migrationKey);

      /*
      FNXC:PostgresMigration 2026-07-22-12:00:
      A completed source marker, not a retained backup's existence, is the
      terminal cutover boundary. Resolve identity from explicit options or the
      PostgreSQL registry before considering legacy SQLite; this makes retained
      fusion.db and archive.db inert on every later CLI, dashboard, desktop,
      and engine boot.
      */
      if (!migrationComplete && existsSync(legacySqlitePath)) {
        let globalDir = options.globalSettingsDir;
        if (!globalDir) {
          try {
            const { resolveGlobalDir } = await import("../global-settings.js");
            globalDir = resolveGlobalDir();
          } catch {
            globalDir = undefined;
          }
        }

        let resolvedFromLegacyCentral = false;
        const centralMigrationComplete = await isSqliteMigrationComplete(
          connections.migration, CENTRAL_SQLITE_MIGRATION_KEY,
        );
        const legacyCentralPath = globalDir ? join(globalDir, "fusion-central.db") : undefined;
        /*
        FNXC:PostgresMigration 2026-07-22-12:00:
        Central identity recovery is itself a legacy SQLite read, so its
        independent completion marker must gate it even when project migration
        remains pending. A completed central backup is never reopened merely to
        resolve a fallback project key.
        */
        if (!centralMigrationComplete && migrationProjectId === fallbackProjectId && legacyCentralPath && existsSync(legacyCentralPath) && isValidSqliteDatabaseFile(legacyCentralPath)) {
          const { DatabaseSync } = await import("../sqlite-adapter.js");
          // FNXC:LegacySqliteBoundary 2026-07-14-18:42: central identity lookup is migration-only and read-only.
          const legacyCentral = new DatabaseSync(legacyCentralPath, { readOnly: true });
          try {
            const row = legacyCentral.prepare(`SELECT id FROM projects WHERE path = ? LIMIT 1`).get(rootDir) as
              | { id: string }
              | undefined;
            migrationProjectId = row?.id ?? migrationProjectId;
            resolvedFromLegacyCentral = Boolean(row?.id);
          } catch {
            // A pre-registry central database leaves legacy single-project startup unbound.
          } finally {
            legacyCentral.close();
          }
        }
        if (migrationProjectId !== fallbackProjectId) {
          try {
            await rekeyFallbackProjectPartition(connections.migration, fallbackProjectId, migrationProjectId);
          } catch (error) {
            const target = error instanceof ProjectPartitionRekeyError
              ? selectDegradedBindTarget(error.ownership)
              : "refuse";
            if (target === "fallback") {
              /* FNXC:ProjectPartitionMerge 2026-07-20-12:00: Failed promotion must carry the pre-transaction fallback binding through every first-boot migration consumer; logging while continuing on the registered scaffold hides user data. */
              log.warn(`startup-factory: partition promotion failed for ${rootDir} (${fallbackProjectId} -> ${migrationProjectId}); binding fallback data for this session (${error instanceof ProjectPartitionRekeyError ? error.reason : "unknown"})`);
              migrationProjectId = fallbackProjectId;
            } else if (target === "registered") {
              log.warn(`startup-factory: partition promotion failed for ${rootDir} (${fallbackProjectId} -> ${migrationProjectId}); fallback was empty, retaining registered binding`);
            } else {
              throw new Error(`startup-factory: refusing project ${rootDir}; project partition reconciliation failed for ${fallbackProjectId} -> ${migrationProjectId}`, { cause: error });
            }
          }
        }
        /*
        FNXC:MultiProjectIsolation 2026-07-11:
        With per-project task partitioning (project_id on project.tasks), the
        first-boot emptiness check must be scoped to THIS project — otherwise
        the second project booting against the shared embedded cluster sees the
        first project's rows and silently skips migrating its own legacy
        fusion.db (the exact data-loss trap Step 5.5 exists to close).

        FNXC:MultiProjectMigration 2026-07-13-22:37:
        Resolve identity from PostgreSQL or the legacy central registry before
        the emptiness check, then count only that partition. NULL or another
        project's rows cannot suppress this migration; global-key collisions
        instead surface through scoped post-copy verification and fail closed.
        Without a registered identity the legacy whole-table check applies.

        FNXC:PostgresCutover 2026-07-14-18:42:
        Order matters: the PostgreSQL emptiness count runs BEFORE the SQLite
        validity probe. The probe is read-only, and steady-state boots (PG
        already populated) still avoid opening SQLite entirely. It runs only
        on the empty-PG path where one-time auto-migration is considered.
        */
        migrationKey = `project:${migrationProjectId}`;
        migrationComplete = await isSqliteMigrationComplete(connections.migration, migrationKey);
        if (!migrationComplete && isValidSqliteDatabaseFile(legacySqlitePath)) {
          // The central (global-dir) source is optional: when no global dir is
          // resolvable (e.g. tests without an explicit dir), migrate only the
          // project-local sources rather than failing the boot.
          /*
          FNXC:PostgresMultiProjectCutover 2026-07-14-11:18:
          The central SQLite database is cluster-global, not a per-project source. Migrate and verify it once, then exclude it from later registered-project cutovers so mutable global rows are not compared with each project's accumulated PostgreSQL state.
          */
          const sources = defaultMigrationSources(fusionDir, globalDir ?? join(fusionDir, "__no-global-dir__"))
            .filter((source) => !centralMigrationComplete || source.pgSchema !== "central")
            .filter((source) => existsSync(source.sqlitePath) && isValidSqliteDatabaseFile(source.sqlitePath));
          if (sources.length > 0) {
            log.log(`startup-factory: empty PostgreSQL database with legacy SQLite data present — auto-migrating ${sources.length} source(s) (SQLite files are kept as backups)`);
            const report = await migrateSqliteToPostgres(connections.migration, sources, {
              skipBaseline: true,
              projectId: migrationProjectId,
              projectPath: rootDir,
              migrationKey,
              deferCompletion: true,
              /*
              FNXC:CliMigrationProgress 2026-07-14-13:47:
              First-boot migration can copy hundreds of thousands of rows. Forward structured phase, table, quarter-copy, and terminal events to the CLI logger so an operator sees forward progress and an explicit rollback instead of a silent startup wait.
              */
              onProgress: (event) => {
                log.log(`startup-factory: SQLite migration — ${formatMigrationProgress(event)}`);
                /*
                FNXC:MigrationHoldingPage 2026-07-17-12:20:
                Forward the same structured event to the caller (CLI holding server)
                so the browser can show live migration progress; observer failures
                must never abort the migration itself.
                */
                try { options.onMigrationProgress?.(event); } catch { /* ignore observer errors */ }
              },
            });
            /*
            FNXC:PostgresMigrationVerification 2026-07-13-22:37:
            Startup may advertise and bind a migrated database only after every non-disposable source table passes row-count and content verification. Fail before project stamping and before the migration notice so conflicts and unmapped operator tables remain diagnosable rather than becoming a false successful cutover.
            */
            const failedTables = report.tables.filter((table) => !table.skipped && !table.verified);
            if (failedTables.length > 0) {
              const failures = failedTables
                .map((table) => `${table.schema}.${table.table} (${table.skipReason ?? `source=${table.sourceRows}, target=${table.targetRows}`})`)
                .join(", ");
              throw new Error(`${failedTables.length} table(s) failed verification: ${failures}`);
            }
            const migratedRows = report.tables.reduce((sum, table) => sum + table.insertedRows, 0);
            /*
            FNXC:MultiProjectIsolation 2026-07-11:
            The SQLite migrator predates partitioning and leaves project_id
            NULL — rows the strict taskProjectScope filter (project_id = $bound)
            would never surface, so the scheduler/board would show an empty
            project right after a "successful" migration. Stamp the
            just-migrated rows with the booting project's id. Safe because the
            scoped emptiness check above guarantees every NULL-project_id row
            in tasks/archived_tasks was written by THIS migration pass.
            */
            /*
            FNXC:MultiProjectIsolation 2026-07-13-21:20:
            The stamping id must also be derivable WITHOUT options.projectId.
            The main cutover path — `fn dashboard` in the project directory —
            boots with rootDir only, so the previous `if (options.projectId)`
            guard skipped stamping on exactly the boot that performs most
            real-world migrations. The rows stayed NULL, every project-bound
            reader (engine InProcessRuntime, dashboard project-store-resolver)
            filtered them out, and the board showed no tasks right after a
            successful migration. When no projectId is bound, resolve it from
            the just-migrated central registry by matching the registered
            project path to this rootDir. If the project was never registered
            centrally, leave rows NULL — readers for unregistered
            single-project setups use an unbound layer with no scope filter.
            */
            const stampProjectId = migrationProjectId
              ?? (await lookupRegisteredProjectIdByPath(connections.migration, rootDir));
            if (stampProjectId) {
              /*
              FNXC:CentralProjectIdentity 2026-07-13-23:10:
              The stamping DML (tasks/archived_tasks NULL→id, config ''→id, and
              the workflow_settings/workflow_prompt_overrides rootDir-key→id
              re-key) is shared with `fn db migrate` via
              stampMigratedProjectRows. rootDir is the pre-isolation key for the
              workflow tables, so it is passed alongside the stamp id.
              */
              await stampMigratedProjectRows(connections.migration, {
                projectId: stampProjectId,
                rootDir,
              });
            }
            /*
            FNXC:PostgresMigration 2026-07-22-12:00:
            A legacy-central identity can be marked complete only after the
            same canonical rootDir resolves to it in PostgreSQL. Otherwise the
            next rootDir-only boot would need SQLite to rediscover its key.
            */
            if (resolvedFromLegacyCentral) {
              const registeredId = await lookupRegisteredProjectIdByPath(connections.migration, rootDir);
              if (registeredId !== migrationProjectId) {
                throw new Error(`legacy project identity ${migrationProjectId} was not materialized for ${rootDir} before migration completion`);
              }
            }
            await completeSqliteMigration(connections.migration, migrationKey);
            if (sources.some((source) => source.pgSchema === "central")) {
              await recordSqliteMigrationComplete(
                connections.migration, CENTRAL_SQLITE_MIGRATION_KEY, stampProjectId,
              );
            }
            /*
            FNXC:PostgresMigrationBanner 2026-07-12:
            Remember the successful auto-migration so the dashboard can show a
            one-time "your data was migrated and a backup exists" banner. The
            notice is persisted into project settings AFTER the TaskStore is
            constructed (the settings write needs the async layer).
            */
            autoMigrationNotice = {
              migratedAt: new Date().toISOString(),
              migratedRows,
              tables: report.tables.length,
              sqliteBackups: sources.map((source) => source.sqlitePath),
            };
            log.log(`startup-factory: SQLite → PostgreSQL auto-migration complete (${migratedRows} row(s) across ${report.tables.length} table(s))`);
          }
        }
      }
      /*
      FNXC:PostgresMigration 2026-07-22-12:00:
      Core and plugin sources have independent completion markers. Dispatch the
      plugin bridge after the core branch so a completed project cutover cannot
      suppress a still-pending plugin adoption; the bridge itself checks its
      marker before validating or opening the retained SQLite file.
      */
      const { migrateLegacyProjectPluginRows } = await import("./sqlite-migrator.js");
      await migrateLegacyProjectPluginRows(connections.migration, legacySqlitePath, rootDir);
    } catch (err) {
      await connections.close().catch(() => undefined);
      await stopEmbeddedRuntime(
        embeddedLifecycle,
        embeddedRuntimeLease,
        embeddedRuntimeUrl,
        embeddedOwnsProcess,
      ).catch(() => undefined);
      throw new Error(
        `startup-factory: SQLite → PostgreSQL first-boot auto-migration failed (refusing to boot an empty database over existing SQLite data; restore the retained backup and run 'fn db migrate' manually): ${describeErrorChain(err)}`,
      );
    }
  }

  // Step 6: construct the AsyncDataLayer.
  // FNXC:MultiProjectIsolation 2026-07-10:
  // Bind the layer to this project so the task-store helpers scope every
  // read/claim/insert on the shared embedded-PG `project.tasks` table to a
  // single project. options.projectId is the central-registry ID both the
  // dashboard (getOrCreateProjectStore) and the engine (InProcessRuntime) pass,
  // so a task's row is stamped and filtered under one consistent partition key.
  /*
  FNXC:CentralProjectIdentity 2026-07-13-22:00:
  rootDir-only boots (fn dashboard / fn serve / desktop / per-path project
  stores) now ALSO bind: when the rootDir is a centrally-registered project,
  its registry id becomes the layer's partition key. cwd/rootDir is only the
  lookup key; identity comes from central.projects. Runs after Step 5.5 so a
  first boot resolves against the registry the migration just populated.
  Unregistered paths resolve to undefined and boot unbound, preserving legacy
  single-project behavior.
  */
  let resolvedProjectId = options.projectId
    ?? (rootDir
      ? (await lookupRegisteredProjectIdByPath(connections.migration, rootDir))
        ?? fallbackProjectIdForRoot(rootDir)
      : undefined);

  if (rootDir && resolvedProjectId) {
    const fallbackProjectId = fallbackProjectIdForRoot(rootDir);
    if (fallbackProjectId !== resolvedProjectId) {
      try {
        await rekeyFallbackProjectPartition(connections.migration, fallbackProjectId, resolvedProjectId);
      } catch (error) {
        const target = error instanceof ProjectPartitionRekeyError
          ? selectDegradedBindTarget(error.ownership)
          : "refuse";
        if (target === "fallback") {
          /* FNXC:ProjectPartitionMerge 2026-07-20-12:00: A rolled-back merge has a reliable ownership snapshot on its typed error. Bind fallback rather than deepening a split by writing the registered scaffold. */
          log.warn(`startup-factory: partition promotion failed for ${rootDir} (${fallbackProjectId} -> ${resolvedProjectId}); binding fallback data for this session (${error instanceof ProjectPartitionRekeyError ? error.reason : "unknown"})`);
          resolvedProjectId = fallbackProjectId;
        } else if (target === "registered") {
          log.warn(`startup-factory: partition promotion failed for ${rootDir} (${fallbackProjectId} -> ${resolvedProjectId}); fallback was empty, retaining registered binding`);
        } else {
          throw new Error(`startup-factory: refusing project ${rootDir}; project partition reconciliation failed for ${fallbackProjectId} -> ${resolvedProjectId}`, { cause: error });
        }
      }
    }
  }

  /*
  FNXC:ProjectDataIsolation 2026-07-14-12:10:
  Schema application and SQLite copy require an administrative connection, but application stores must never inherit that bypass. Replace the bootstrap pools with project-bound sessions before constructing any store so every agent and satellite query is constrained by forced RLS.
  */
  if (resolvedProjectId) {
    const runtimeRoleRows = (await connections.migration.execute(sql`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime')
        AND pg_has_role(current_user, 'fusion_runtime', 'MEMBER') AS usable
    `)) as unknown as Array<{ usable: boolean }>;
    await connections.close();
    connections = await createConnectionSetFromUrl(resolvedBackend, {
      poolMax: options.poolMax,
      projectId: resolvedProjectId,
      useRuntimeRole: runtimeRoleRows[0]?.usable === true,
    });
  }
  const asyncLayer = createAsyncDataLayer(connections, { projectId: resolvedProjectId });

  // Step 7: construct the TaskStore in backend mode.
  /*
  FNXC:PostgresCutover 2026-07-10 (fork review, TrinaryCompute/postgres-v057):
  When BOTH projectId and rootDir are provided, the explicit rootDir must win.
  Previously the projectId branch dropped options.rootDir and re-resolved the
  path via CentralCore from process.cwd(), so a scoped store could root at the
  DASHBOARD's cwd instead of the project dir. The observable failure: createTask
  wrote the bootstrap PROMPT.md stub under the dashboard cwd while triage wrote
  the real spec under the project dir, so isUnplannedForExecution kept reading
  the stale stub and pinned every card "unplanned" forever (never dispatched).
  */
  let taskStore: TaskStore;
  try {
    const constructT0 = Date.now();
    if (options.projectId && !options.rootDir) {
      taskStore = await TaskStore.getOrCreateForProject(
        options.projectId,
        undefined,
        options.globalSettingsDir,
        asyncLayer,
      );
    } else {
      taskStore = new TaskStore(rootDir, options.globalSettingsDir, {
        asyncLayer,
      });
      await taskStore.init();
    }
    log.log(`startup phase backend.taskStore.construct: ${Date.now() - constructT0}ms`);
  } catch (err) {
    await asyncLayer.close().catch(() => undefined);
    await stopEmbeddedRuntime(
      embeddedLifecycle,
      embeddedRuntimeLease,
      embeddedRuntimeUrl,
      embeddedOwnsProcess,
    ).catch(() => undefined);
    throw new Error(
      `startup-factory: failed to construct PostgreSQL-backed TaskStore: ${describeErrorChain(err)}`,
    );
  }
  /*
  FNXC:SettingsBackups 2026-07-16-16:00:
  This is deliberately the sole store-open entry point for the coordinated backup
  scope migration. The TaskStore now exposes the JSON GlobalSettingsStore while
  the bound AsyncDataLayer provides central marker/lock access; schema bootstrap
  has neither capability and must not attempt this cross-storage migration.
  */
  await (await import("../backup-settings-migration.js")).migrateBackupSettingsToGlobalOnce(
    taskStore.getAsyncLayer(),
    taskStore.getGlobalSettingsStore(),
  );
  log.log(`startup phase backend.factory.total: ${Date.now() - factoryT0}ms`);

  /*
  FNXC:PluginPostgresContract 2026-07-14-18:32:
  Plugin DDL uses a one-shot administrative pool created only after a validated
  declarative plan arrives. The TaskStore holds the executor capability, not
  the connection, and PluginContext exposes neither one to runtime hooks.
  */
  taskStore.setPluginPostgresSchemaExecutor(async (contracts: readonly LoadedPluginSchemaContract[]) => {
    const schemaConnections = resolvedBackend.mode === "external"
      ? await createConnectionSet(env, {
          backend: resolvedBackend,
          poolMax: 1,
          bypassProjectIsolation: true,
        })
      : await createConnectionSetFromUrl(resolvedBackend, {
          poolMax: 1,
          bypassProjectIsolation: true,
        });
    try {
      await runLoadedPluginSchemaInitHooks(schemaConnections.migration, contracts);
    } finally {
      await schemaConnections.close();
    }
  });

  /*
  FNXC:PostgresMigrationBanner 2026-07-12:
  Step 7.5 — persist the auto-migration notice into project settings so the
  dashboard shows a one-time "your data was migrated and a backup exists"
  banner (dismissible; a "Need help?" button links to the Fusion Discord).
  Best-effort: a failed settings write must not fail a boot whose migration
  already succeeded — the loud path is the migration itself (Step 5.5).
  */
  if (autoMigrationNotice) {
    try {
      const { patchProjectSettings } = await import("../task-store/async-settings.js");
      await patchProjectSettings(asyncLayer, {
        sqliteMigrationNotice: { ...autoMigrationNotice, dismissed: false },
      });
    } catch (err) {
      log.warn(`startup-factory: failed to persist the migration notice (banner will not show): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // FNXC:SqliteRemoval 2026-06-25-00:00:
  // Dual-read harness integration removed. The dual-read cutover harness was
  // a transitional operator tool that should NOT ship to end users. The upgrade
  // path is auto-migrate (migrator + row-count verification) + keep the SQLite
  // file as a backup. The harness was deleted so it never becomes a maintenance
  // burden.

  const shutdownEmbedded = embeddedLifecycle;
  return {
    taskStore,
    backend: resolvedBackend,
    asyncLayer,
    async shutdown() {
      // Close the TaskStore first (releases the AsyncDataLayer / pool), then
      // stop the embedded cluster if one was started. Best-effort: log errors.
      try {
        await taskStore.close();
      } catch (err) {
        log.warn(`startup-factory: TaskStore.close() failed during shutdown: ${
          err instanceof Error ? err.message : String(err)
        }`);
      }
      if (shutdownEmbedded) {
        try {
          await stopEmbeddedRuntime(
            shutdownEmbedded,
            embeddedRuntimeLease,
            embeddedRuntimeUrl,
            embeddedOwnsProcess,
          );
        } catch (err) {
          log.warn(`startup-factory: embedded PostgreSQL stop failed during shutdown: ${
            err instanceof Error ? err.message : String(err)
          }`);
        }
      }
    },
  
    async detachKeepingEmbedded() {
      try {
        await taskStore.close();
      } catch (err) {
        log.warn(`startup-factory: TaskStore.close() failed during detach: ${
          err instanceof Error ? err.message : String(err)
        }`);
      }
      if (shutdownEmbedded) {
        try {
          (shutdownEmbedded as unknown as { detachWithoutStop?: () => void }).detachWithoutStop?.();
          if (embeddedRuntimeLease) releaseEmbeddedRuntimeLease(embeddedRuntimeLease);
        } catch (err) {
          log.warn(`startup-factory: embedded PostgreSQL detach failed: ${
            err instanceof Error ? err.message : String(err)
          }`);
        }
      }
    },
  };
}

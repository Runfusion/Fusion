/**
 * Runtime startup factory: construct a PostgreSQL-backed TaskStore.
 *
 * FNXC:RuntimeStartupWiring 2026-06-26-14:00:
 * This is the single startup entry point that production construction sites
 * (engine InProcessRuntime, dashboard project-store-resolver, CLI serve/
 * dashboard commands, desktop local-server/local-runtime) consult to decide
 * whether to boot against PostgreSQL or fall back to the legacy SQLite path.
 *
 * The factory encapsulates the five-step backend boot sequence so individual
 * call sites do not each re-implement backend resolution, connection opening,
 * schema application, AsyncDataLayer construction, and dual-read harness
 * integration. A call site asks: "given the current environment, do I get a
 * PostgreSQL-backed TaskStore, or do I keep the SQLite default?" The factory
 * answers with either a ready {@link BackendBootResult} or `null` (meaning:
 * use the legacy SQLite construction — byte-identical to the pre-migration
 * path).
 *
 * Resolution rules (matching the mission architecture):
 *   - DATABASE_URL set (external mode): connect to the external PostgreSQL
 *     server, apply the schema baseline, construct the AsyncDataLayer. Returns
 *     a backend boot result.
 *   - DATABASE_URL unset (embedded mode): start the bundled embedded
 *     PostgreSQL, then proceed like external mode against the embedded URL.
 *     This is the DEFAULT production path — embedded PG is the zero-config
 *     backend, mirroring the zero-config SQLite experience it replaces.
 *   - DATABASE_URL unset AND FUSION_NO_EMBEDDED_PG=1: return `null`. The caller
 *     constructs the legacy SQLite-backed TaskStore. This is the explicit
 *     opt-out for the legacy SQLite path, available for backward compatibility
 *     during the cutover window.
 *
 * FNXC:BackendFlip 2026-06-26-14:05:
 * The default backend was flipped from SQLite to embedded PostgreSQL in this
 * change (feature flip-embedded-pg-default, cutover milestone). Previously
 * embedded PG required an explicit opt-in via FUSION_EMBEDDED_PG=1; now it is
 * the default and FUSION_NO_EMBEDDED_PG=1 is the opt-out back to legacy
 * SQLite. FUSION_EMBEDDED_PG=1 is still honored as a no-op alias for backward
 * compatibility (it cannot force embedded when DATABASE_URL is set, since
 * external mode always wins). The flip is safe because the embedded-postgres
 * platform binaries are now bundled for macOS/Linux/Windows (arm64/x64) and
 * the boot smoke has been updated to exercise the embedded path by default
 * with an initdb-aware health-check timeout. Tests that need the fast SQLite
 * default (no initdb, no binary) set FUSION_NO_EMBEDDED_PG=1 explicitly.
 */

import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { sql as drizzleSql } from "drizzle-orm";
import { isValidSqliteDatabaseFile } from "../sqlite-validation.js";
import { createLogger } from "../logger.js";
import { TaskStore } from "../store.js";
import {
  resolveBackend,
  describeBackendForLog,
  type ResolvedBackend,
} from "./backend-resolver.js";
import {
  createConnectionSet,
  createConnectionSetFromUrl,
  DatabaseConnectionError,
} from "./connection.js";
import { applySchemaBaseline } from "./schema-applier.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "./data-layer.js";

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
};

const log = createLogger("startup-factory");

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
 * Opt-out environment variable that forces the legacy SQLite backend when
 * DATABASE_URL is unset. This is the escape hatch for the cutover window:
 * operators or tests that need the fast, no-binary SQLite default set
 * FUSION_NO_EMBEDDED_PG=1. Truthy values: 1, true, yes, on (case-insensitive).
 * Everything else (unset, 0, no, false, off) means "use the embedded PG
 * default".
 */
export const NO_EMBEDDED_PG_ENV = "FUSION_NO_EMBEDDED_PG";

/**
 * Return true when the embedded PostgreSQL backend should be used in embedded
 * mode (DATABASE_URL unset).
 *
 * FNXC:BackendFlip 2026-06-26-14:15:
 * Post default-flip, embedded PG is the DEFAULT in embedded mode. The legacy
 * FUSION_EMBEDDED_PG opt-in is now a no-op (setting it does nothing because
 * embedded is already on). The only way to opt OUT of embedded PG back to
 * legacy SQLite is FUSION_NO_EMBEDDED_PG=1. This function returns true unless
 * the opt-out is set.
 *
 * The opt-out is honored when set to a truthy value: 1, true, yes, on
 * (case-insensitive). Everything else (unset, 0, no, false, off) means
 * "use the embedded PG default" (return true).
 *
 * @returns true when embedded PG should be used (the default); false when the
 *          operator explicitly opted out via FUSION_NO_EMBEDDED_PG=1.
 */
export function isEmbeddedPgRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isEmbeddedPgOptedOut(env);
}

/**
 * FNXC:BackendFlip 2026-06-26-14:15:
 * Return true when the operator has explicitly opted out of embedded PG via
 * FUSION_NO_EMBEDDED_PG=1 (the legacy SQLite escape hatch). Exposed for test
 * assertion and call-site cheap checks.
 */
export function isEmbeddedPgOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[NO_EMBEDDED_PG_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
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
   * read from the environment: embedded PG is on by default unless
   * FUSION_NO_EMBEDDED_PG=1 is set. Pass `true` to force embedded, `false` to
   * force the legacy SQLite path.
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
}

/**
 * Decide whether the factory should attempt a PostgreSQL boot for the given
 * environment. Returns true when DATABASE_URL is set (external) or embedded PG
 * is the default (DATABASE_URL unset, no opt-out). Returns false only when the
 * operator explicitly opted out via FUSION_NO_EMBEDDED_PG=1.
 *
 * Exposed so call sites can cheaply check "should I even try PostgreSQL?"
 * before awaiting the full factory (which opens connections).
 */
export function shouldUsePostgresBackend(
  env: NodeJS.ProcessEnv = process.env,
  opts: { embeddedPgRequested?: boolean } = {},
): boolean {
  const backend = resolveBackend(env);
  if (backend.mode === "external") return true;
  const embeddedRequested = opts.embeddedPgRequested ?? isEmbeddedPgRequested(env);
  return embeddedRequested;
}

/**
 * Construct a PostgreSQL-backed TaskStore for the current environment, or
 * return `null` when the legacy SQLite path should be used.
 *
 * FNXC:BackendFlip 2026-06-26-14:20:
 * Post default-flip, the sequence is:
 *   1. Resolve the backend (external via DATABASE_URL, or embedded when unset).
 *   2. If embedded mode AND the operator opted out (FUSION_NO_EMBEDDED_PG=1),
 *      return null — caller uses legacy SQLite.
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
 * @returns the backend boot result, or `null` to use the legacy SQLite path.
 */
export async function createTaskStoreForBackend(
  options: CreateTaskStoreForBackendOptions,
): Promise<BackendBootResult | null> {
  const env = options.env ?? process.env;
  const backend = options.backend ?? resolveBackend(env);
  const embeddedRequested = options.embeddedPgRequested ?? isEmbeddedPgRequested(env);

  // FNXC:BackendFlip 2026-06-26-14:25:
  // Step 2: the ONLY way to reach the legacy SQLite path post default-flip is
  // the explicit opt-out (FUSION_NO_EMBEDDED_PG=1). When the operator opts out,
  // `embeddedRequested` is false and we return null so the caller constructs the
  // legacy SQLite-backed TaskStore. In every other embedded-mode case, embedded
  // PG is the default and we proceed to boot it.
  if (backend.mode === "embedded" && !embeddedRequested) {
    return null;
  }

  // When constructing via the constructor (no projectId), rootDir is required.
  if (!options.projectId && !options.rootDir) {
    throw new Error(
      "createTaskStoreForBackend: rootDir is required when projectId is not provided",
    );
  }
  const rootDir = options.rootDir ?? "";

  let embeddedLifecycle: EmbeddedLifecycleLike | null = null;
  let resolvedBackend: ResolvedBackend = backend;

  // Step 4: embedded mode — start the bundled PostgreSQL first so we have a
  // connection URL. createConnectionSet throws in embedded mode without a URL.
  //
  // FNXC:BackendFlip 2026-06-26-14:25:
  // This branch now runs by default in embedded mode (DATABASE_URL unset)
  // unless the operator opted out. The embedded-lifecycle module is imported
  // LAZILY here (see the note at the top of the file) so the `embedded-postgres`
  // package and its platform-specific dynamic imports stay out of the CLI
  // bundle unless embedded PG is actually used at runtime.
  if (backend.mode === "embedded" && embeddedRequested) {
    const { EmbeddedPostgresLifecycle, defaultEmbeddedDataDir, DEFAULT_EMBEDDED_DATABASE } =
      await import("./embedded-lifecycle.js");
    const dataDir = resolve(options.embeddedDataDir ?? defaultEmbeddedDataDir());
    log.log(`startup-factory: starting embedded PostgreSQL (data dir ${dataDir})`);
    embeddedLifecycle = new EmbeddedPostgresLifecycle({
      dataDir,
      database: DEFAULT_EMBEDDED_DATABASE,
      onLog: (msg) => log.log(msg),
      onError: (err) => log.error(String(err)),
    });
    try {
      resolvedBackend = await embeddedLifecycle.start();
    } catch (err) {
      // FNXC:BackendFlip 2026-06-26-14:25:
      // Embedded startup failure is fatal — embedded PG is the default and the
      // operator did not opt out. Surface a clear error rather than silently
      // falling back to SQLite (which would mask a real binary/environment
      // problem and could split-write two backends).
      await embeddedLifecycle.stop().catch(() => undefined);
      throw new Error(
        `startup-factory: failed to start embedded PostgreSQL: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  log.log(describeBackendForLog(resolvedBackend));

  // Steps 3 & 4 (connection opening). External mode uses createConnectionSet
  // (resolves from env); embedded mode uses createConnectionSetFromUrl with
  // the lifecycle-provided URL.
  let connections;
  try {
    if (resolvedBackend.mode === "external") {
      connections = await createConnectionSet(env, {
        backend: resolvedBackend,
        poolMax: options.poolMax,
      });
    } else {
      connections = await createConnectionSetFromUrl(resolvedBackend, {
        poolMax: options.poolMax,
      });
    }
  } catch (err) {
    // VAL-CONN-004: unreachable DATABASE_URL fails loudly. If we started an
    // embedded cluster, stop it before propagating.
    if (embeddedLifecycle) {
      await embeddedLifecycle.stop().catch(() => undefined);
    }
    if (err instanceof DatabaseConnectionError) {
      throw err;
    }
    throw err;
  }

  // Step 5: apply the schema baseline (idempotent) to the migration connection.
  try {
    await applySchemaBaseline(connections.migration);
  } catch (err) {
    await connections.close().catch(() => undefined);
    if (embeddedLifecycle) {
      await embeddedLifecycle.stop().catch(() => undefined);
    }
    throw new Error(
      `startup-factory: failed to apply PostgreSQL schema baseline: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

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
  if (rootDir) {
    try {
      const fusionDir = join(rootDir, ".fusion");
      const legacySqlitePath = join(fusionDir, "fusion.db");
      if (existsSync(legacySqlitePath) && isValidSqliteDatabaseFile(legacySqlitePath)) {
        /*
        FNXC:MultiProjectIsolation 2026-07-11:
        With per-project task partitioning (project_id on project.tasks), the
        first-boot emptiness check must be scoped to THIS project — otherwise
        the second project booting against the shared embedded cluster sees the
        first project's rows and silently skips migrating its own legacy
        fusion.db (the exact data-loss trap Step 5.5 exists to close). NULL
        project_id rows are counted as blocking: they may be this project's
        pre-isolation data, and migrating on top of them risks id collisions.
        Without a bound projectId the pre-isolation whole-table check applies.
        */
        const countRows = (await connections.migration.execute(
          options.projectId
            ? drizzleSql`SELECT count(*)::int AS count FROM project.tasks WHERE project_id = ${options.projectId} OR project_id IS NULL`
            : drizzleSql`SELECT count(*)::int AS count FROM project.tasks`,
        )) as Array<{ count: number }>;
        const pgTaskCount = Number(countRows[0]?.count ?? 0);
        if (pgTaskCount === 0) {
          const { migrateSqliteToPostgres, defaultMigrationSources } = await import("./sqlite-migrator.js");
          // The central (global-dir) source is optional: when no global dir is
          // resolvable (e.g. tests without an explicit dir), migrate only the
          // project-local sources rather than failing the boot.
          let globalDir = options.globalSettingsDir;
          if (!globalDir) {
            try {
              const { resolveGlobalDir } = await import("../global-settings.js");
              globalDir = resolveGlobalDir();
            } catch {
              globalDir = undefined;
            }
          }
          const sources = defaultMigrationSources(fusionDir, globalDir ?? join(fusionDir, "__no-global-dir__"))
            .filter((source) => existsSync(source.sqlitePath) && isValidSqliteDatabaseFile(source.sqlitePath));
          if (sources.length > 0) {
            log.log(`startup-factory: empty PostgreSQL database with legacy SQLite data present — auto-migrating ${sources.length} source(s) (SQLite files are kept as backups)`);
            const report = await migrateSqliteToPostgres(connections.migration, sources, { skipBaseline: true });
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
            if (options.projectId) {
              await connections.migration.execute(
                drizzleSql`UPDATE project.tasks SET project_id = ${options.projectId} WHERE project_id IS NULL`,
              );
              await connections.migration.execute(
                drizzleSql`UPDATE project.archived_tasks SET project_id = ${options.projectId} WHERE project_id IS NULL`,
              );
            }
            log.log(`startup-factory: SQLite → PostgreSQL auto-migration complete (${migratedRows} row(s) across ${report.tables.length} table(s))`);
          }
        }
      }
    } catch (err) {
      await connections.close().catch(() => undefined);
      if (embeddedLifecycle) {
        await embeddedLifecycle.stop().catch(() => undefined);
      }
      throw new Error(
        `startup-factory: SQLite → PostgreSQL first-boot auto-migration failed (refusing to boot an empty database over existing SQLite data; run 'fn db migrate' manually or set FUSION_NO_EMBEDDED_PG=1 to stay on SQLite): ${
          err instanceof Error ? err.message : String(err)
        }`,
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
  const asyncLayer = createAsyncDataLayer(connections, { projectId: options.projectId });

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
  } catch (err) {
    await asyncLayer.close().catch(() => undefined);
    if (embeddedLifecycle) {
      await embeddedLifecycle.stop().catch(() => undefined);
    }
    throw new Error(
      `startup-factory: failed to construct PostgreSQL-backed TaskStore: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
          await shutdownEmbedded.stop();
        } catch (err) {
          log.warn(`startup-factory: embedded PostgreSQL stop failed during shutdown: ${
            err instanceof Error ? err.message : String(err)
          }`);
        }
      }
    },
  };
}

/**
 * PostgreSQL connection layer.
 *
 * FNXC:PostgresConnection 2026-06-24-02:05:
 * Barrel export for the postgres connection subsystem. This module provides
 * backend resolution (embedded vs external), connection pool management with
 * the DATABASE_MIGRATION_URL split, and credential redaction.
 *
 * Consumers:
 *   - The embedded lifecycle feature (U2) calls createConnectionSetFromUrl()
 *     after starting the bundled Postgres.
 *   - The external startup path calls createConnectionSet() with DATABASE_URL set.
 *   - Tests use resolveBackend() and the credential-redact helpers directly.
 */

export {
  resolveBackend,
  resolveBackendWithOptions,
  looksLikePoolerUrl,
  poolerWarning,
  describeBackendForLog,
  DATABASE_URL_ENV,
  DATABASE_MIGRATION_URL_ENV,
  POOLER_PREPARED_STATEMENT_WARNING,
  type BackendMode,
  type ResolvedBackend,
  type ResolveBackendOptions,
} from "./backend-resolver.js";

export {
  createConnectionSet,
  createConnectionSetFromUrl,
  verifyConnection,
  DatabaseConnectionError,
  redactConnectionString,
  type PostgresConnections,
  type CreateConnectionOptions,
} from "./connection.js";

export {
  registerEmbeddedRuntimeUrl,
  releaseEmbeddedRuntimeLease,
  invalidateEmbeddedRuntimeUrl,
  getActiveEmbeddedRuntimeUrl,
  clearActiveEmbeddedRuntimeUrl,
  type EmbeddedRuntimeLease,
} from "./active-backend-registry.js";

export {
  redactUrlPassword,
  redactUrlQueryPassword,
  redactKeywordPassword,
  redactConnectionString as redactCredentials,
  redactCredentialsFromMessage,
  REDACTED_PASSWORD_PLACEHOLDER,
} from "./credential-redact.js";

// FNXC:RuntimeStartupWiring 2026-06-24-11:05:
// The embedded PostgreSQL lifecycle module (embedded-lifecycle.ts) imports the
// `embedded-postgres` package, which uses dynamic import() for platform-
// specific optional binaries (@embedded-postgres/linux-x64, etc.). Re-exporting
// it from this barrel would pull those unresolved imports into every consumer
// of @fusion/core — including the CLI bundle (tsup/esbuild bundles @fusion/*
// with noExternal), which breaks the build and the boot smoke on platforms
// whose optional binary is absent.
//
// The embedded lifecycle is therefore NOT re-exported here. The runtime
// startup factory (startup-factory.ts) loads it lazily via await import()
// only when FUSION_EMBEDDED_PG=1, and the integration tests import it
// directly from "./embedded-lifecycle.js". This keeps the embedded-postgres
// dependency out of the static import graph of every other consumer.

/**
 * FNXC:PostgresSchema 2026-06-24-03:50:
 * Drizzle schema-as-code for the three application databases (project/central/
 * archive) and plugin-owned tables. The fresh migration baseline
 * (migrations/0000_initial.sql) materializes these definitions; the schema
 * applier applies the baseline + plugin hooks to a connection.
 */
export * as schema from "./schema/index.js";
export {
  applySchemaBaseline,
  getAppliedMigrations,
  readBaselineMigrationSql,
  SCHEMA_BASELINE_VERSION,
  // FNXC:StaleBinaryGuard 2026-07-19-03:10 (U9b / R10): old-binary write refusal.
  StaleBinarySchemaError,
  assertBinaryNotOlderThanDatabase,
  WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION,
  PROJECT_OWNERSHIP_SCHEMA_VERSION,
  SESSION_ADVISOR_ENABLED_SCHEMA_VERSION,
  MIGRATION_BOOKKEEPING_TABLE,
} from "./schema-applier.js";
export {
  roadmapPluginSchemaInit,
  cePluginSchemaInit,
  whatsappPluginSchemaInit,
  evenRealitiesPluginSchemaInit,
  reportsPluginSchemaInit,
  cliPressPluginSchemaInit,
  DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS,
  runPluginSchemaInitHooks,
  runLoadedPluginSchemaInitHooks,
  assertLoadedPluginSchemaInitHooksSupported,
  type PluginSchemaInitHook,
  type LoadedPluginSchemaContract,
} from "./plugin-schema-hook.js";

/**
 * FNXC:AsyncDataLayer 2026-06-24-10:30:
 * Async data-layer foundation (U4). The stable `AsyncDataLayer` interface that
 * replaces the synchronous `DatabaseSync` adapter. Plugin stores and the
 * decomposed task-store modules program against this interface so the
 * SQLite→PostgreSQL backend swap is invisible to them (VAL-DATA-016).
 *
 * The `getDatabase()` accessor on `TaskStore` will return an async-capable
 * connection backed by this interface; the direct-`prepare()` consumers that
 * relied on the synchronous `Database` shape are converted in U15.
 *
 * Consumers:
 *   - U12-U14 (task-store module migrations) call `layer.transactionImmediate()`
 *     and `recordRunAuditEventWithinTransaction(tx, ...)` to preserve the
 *     run-audit-event-within-transaction atomicity.
 *   - U6 (satellite stores) construct an `AsyncDataLayer` per database.
 *   - Plugin stores (`fusion-plugin-roadmap`) consume the stable interface.
 */
export {
  createAsyncDataLayer,
  recordRunAuditEvent,
  recordRunAuditEventWithinTransaction,
  projectTable,
  type AsyncDataLayer,
  type DrizzleDb,
  type DbTransaction,
  type TransactionOptions,
  type RunAuditEventInput,
  type RunAuditEvent,
} from "./data-layer.js";

/**
 * FNXC:PostgresHealth 2026-06-24-16:00:
 * PostgreSQL health and maintenance surface (U8). Replaces SQLite-specific
 * surfaces (PRAGMA integrity_check, VACUUM-on-SQLite, WAL checkpointing,
 * PRAGMA table_info schema self-heal) with PostgreSQL equivalents:
 *   - Health check via connectivity probe + pg_stat_database (VAL-HEALTH-001/002)
 *   - Schema drift detection via information_schema with self-heal (VAL-HEALTH-004)
 *   - Explicit VACUUM/ANALYZE compaction with stats (VAL-HEALTH-005)
 *   - Async task-ID integrity detector (VAL-HEALTH-003)
 */
export {
  checkPostgresHealth,
  detectSchemaDrift,
  healSchemaDrift,
  validateAndHealSchema,
  vacuumAnalyze,
  EXPECTED_PROJECT_COLUMNS,
  type PostgresHealthSnapshot,
  type SchemaDriftFinding,
  type SchemaValidationReport,
  type VacuumAnalyzeStats,
  type VacuumAnalyzeResult,
} from "./postgres-health.js";
export {
  detectTaskIdIntegrityAnomaliesAsync,
} from "./async-task-id-integrity.js";

/**
 * FNXC:PostgresMigration 2026-06-24-10:00:
 * SQLite-to-PostgreSQL data migration tool (U9 / VAL-MIGRATE-001..006).
 * Snapshots the current final SQLite schema into PostgreSQL and bulk-copies
 * all data across the three Fusion databases, idempotently and with
 * verification. Used at cutover to migrate a populated SQLite deployment into
 * PostgreSQL. The cutover harness (dual-read-cutover) and SQLite removal
 * (sqlite-removal) features consume this tool.
 */
export {
  migrateSqliteToPostgres,
  isSqliteMigrationComplete,
  completeSqliteMigration,
  defaultMigrationSources,
  formatMigrationProgress,
  toSnakeCase,
  type SqliteMigrationSource,
  type SchemaName,
  type MigrationOptions,
  type MigrationReport,
  type MigrationProgressEvent,
  type MigrationProgressPhase,
  type TableMigrationResult,
} from "./sqlite-migrator.js";

/**
 * FNXC:CentralProjectIdentity 2026-07-13-23:10:
 * Post-migration project-partition stamping, shared by the startup-factory
 * first-boot auto-migration and the manual `fn db migrate` cutover command so
 * migrated rows (tasks/archived_tasks/config/workflow settings) are re-keyed to
 * the central-registry project id on BOTH paths.
 */
export {
  stampMigratedProjectRows,
  lookupRegisteredProjectIdByPath,
  type StampMigratedProjectRowsInput,
  type StampMigratedProjectRowsResult,
} from "./migration-stamping.js";

/**
 * FNXC:BackendFlip 2026-06-26-14:30:
 * Runtime startup factory (cutover milestone). `createTaskStoreForBackend()`
 * is the single entry point production construction sites consult to decide
 * how to boot PostgreSQL. Embedded PostgreSQL is the zero-config default and
 * DATABASE_URL selects an external service; the removed SQLite opt-out is
 * rejected so callers always receive a live backend result.
 */
export {
  createTaskStoreForBackend,
  createCentralBackendLayer,
  shouldUsePostgresBackend,
  isEmbeddedPgRequested,
  isEmbeddedPgOptedOut,
  EMBEDDED_PG_ENV,
  NO_EMBEDDED_PG_ENV,
  TEST_MODE_ENV,
  TEST_DATABASE_URL_ENV,
  TEST_DATABASE_MIGRATION_URL_ENV,
  type BackendBootResult,
  type CentralBackendLayerResult,
  type CreateTaskStoreForBackendOptions,
} from "./startup-factory.js";

/**
 * FNXC:PostgresBackup 2026-06-24-21:00:
 * PostgreSQL backup and restore via pg_dump/pg_restore (U11 / VAL-REMOVAL-003).
 * After the SQLite cutover, backups are PostgreSQL logical dumps instead of
 * SQLite file copies. This module preserves the project + central pairing.
 */
export {
  PgBackupManager,
  PROJECT_BACKUP_SCHEMAS,
  CENTRAL_BACKUP_SCHEMAS,
  parsePgUrl,
  type PgBackupOptions,
  type PgBackupPair,
  type PgDumpResult,
} from "./pg-backup.js";

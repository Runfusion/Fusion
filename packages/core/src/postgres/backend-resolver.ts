/**
 * PostgreSQL backend resolution.
 *
 * FNXC:PostgresConnection 2026-06-24-01:45:
 * The engine supports two modes, resolved at startup by checking DATABASE_URL:
 *   1. DATABASE_URL set → external/remote PostgreSQL (no embedded instance started).
 *   2. DATABASE_URL unset → embedded mode (handled by the embedded-lifecycle feature).
 *
 * The resolver is a pure function over environment variables: it does not open
 * connections or start processes. It returns a descriptor that the connection
 * layer (connection.ts) and the embedded lifecycle manager consume.
 *
 * DATABASE_MIGRATION_URL:
 * When the runtime DATABASE_URL uses a transaction-pooling connection (Supavisor/
 * PgBouncer in transaction mode), prepared statements break because each
 * transaction may land on a different backend connection. The migration URL
 * routes schema/migration work to a direct (non-pooled) connection. If
 * DATABASE_MIGRATION_URL is unset, schema work uses the runtime URL.
 *
 * Pooled-URL warning:
 * When DATABASE_URL looks like a transaction pooler and no DATABASE_MIGRATION_URL
 * is set, a warning is emitted about prepared-statement risk (VAL-CONN-008).
 */

import { redactConnectionString } from "./credential-redact.js";

/** The resolved backend mode. */
export type BackendMode = "embedded" | "external";

/**
 * The resolved connection targets for the PostgreSQL backend.
 *
 * - `mode` — whether the backend is embedded (local bundled Postgres) or
 *   external (a user-provided DATABASE_URL).
 * - `runtimeUrl` — the connection string used for runtime queries. In embedded
 *   mode this is null until the embedded lifecycle provides it.
 * - `migrationUrl` — the connection string used for schema/migration work. Falls
 *   back to `runtimeUrl` when DATABASE_MIGRATION_URL is not set.
 * - `migrationUrlOverridden` — true when DATABASE_MIGRATION_URL was explicitly
 *   set (used for logging and the pooler-warning gate).
 */
export interface ResolvedBackend {
  readonly mode: BackendMode;
  readonly runtimeUrl: string | null;
  readonly migrationUrl: string | null;
  readonly migrationUrlOverridden: boolean;
}

/**
 * Options for resolving the backend. Defaults read from `process.env` so the
 * resolver remains a pure function over its inputs and is trivially testable.
 */
export interface ResolveBackendOptions {
  /** The runtime connection string (DATABASE_URL). */
  readonly databaseUrl?: string | null;
  /** The migration connection string (DATABASE_MIGRATION_URL). */
  readonly databaseMigrationUrl?: string | null;
}

/** Environment variable names used for backend resolution. */
export const DATABASE_URL_ENV = "DATABASE_URL";
export const DATABASE_MIGRATION_URL_ENV = "DATABASE_MIGRATION_URL";

/**
 * Resolve the PostgreSQL backend from environment variables.
 *
 * Rules:
 *   - DATABASE_URL set and non-empty → external mode, runtimeUrl = DATABASE_URL.
 *   - DATABASE_URL unset or empty → embedded mode, runtimeUrl = null.
 *   - migrationUrl = DATABASE_MIGRATION_URL if set, else runtimeUrl.
 *
 * Whitespace-only values are treated as unset (empty).
 */
export function resolveBackend(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBackend {
  return resolveBackendWithOptions({
    databaseUrl: env[DATABASE_URL_ENV] ?? null,
    databaseMigrationUrl: env[DATABASE_MIGRATION_URL_ENV] ?? null,
  });
}

/**
 * Resolve the backend from explicit option values (testable without env mutation).
 */
export function resolveBackendWithOptions(
  opts: ResolveBackendOptions,
): ResolvedBackend {
  const databaseUrl = (opts.databaseUrl ?? "").trim();
  const databaseMigrationUrl = (opts.databaseMigrationUrl ?? "").trim();

  const mode: BackendMode = databaseUrl.length > 0 ? "external" : "embedded";
  const runtimeUrl = mode === "external" ? databaseUrl : null;

  // In embedded mode, DATABASE_MIGRATION_URL is meaningless (the embedded
  // lifecycle provides its own connection URLs). Only honor it in external mode.
  const migrationUrlOverridden = mode === "external" && databaseMigrationUrl.length > 0;
  const migrationUrl = migrationUrlOverridden
    ? databaseMigrationUrl
    : runtimeUrl;

  return { mode, runtimeUrl, migrationUrl, migrationUrlOverridden };
}

// ── Pooler detection ─────────────────────────────────────────────────

/**
 * Heuristic detection of transaction-pooling connection strings.
 *
 * FNXC:PostgresConnection 2026-06-24-01:50:
 * Transaction poolers (Supavisor, PgBouncer in transaction mode) break
 * prepared statements because each transaction may use a different backend
 * connection. Drizzle/postgres.js uses prepared statements by default
 * (`prepare: true`), which silently fails under a transaction pooler.
 *
 * Detection is heuristic — there is no reliable way to know the server-side
 * pool mode from a connection string alone. We check for common pooler host
 * patterns and the `?pgbouncer=true` / `?pool_mode=transaction` query params.
 *
 * Known pooler host indicators:
 *   - Supavisor: `*.supavisor.*`, `*.pooler.supabase.*`
 *   - PgBouncer: hosts containing `pgbouncer` (rare in the URL but possible)
 *   - Supabase pooler: `*.pooler.supabase.com`, `*.pooler.supabase.co`
 */
export function looksLikePoolerUrl(url: string): boolean {
  const lower = url.toLowerCase();

  // Query-parameter hints (explicit pooler configuration)
  if (/[?&]pgbouncer=true\b/i.test(lower)) return true;
  if (/[?&]pool_mode=transaction\b/i.test(lower)) return true;

  // Host-based heuristics for well-known managed poolers
  if (/\.supavisor\./i.test(lower)) return true;
  if (/\.pooler\.supabase\./i.test(lower)) return true;
  if (/\bpgbouncer\b/i.test(lower)) return true;

  // Supavisor uses port 6543 / 5432 in pooler mode — but port alone is too
  // noisy (many local Postgres instances use 5432). Only flag the host patterns.

  return false;
}

/**
 * The warning text emitted when a pooled runtime URL is used without a
 * DATABASE_MIGRATION_URL. Exported for test assertion (VAL-CONN-008).
 */
export const POOLER_PREPARED_STATEMENT_WARNING =
  "DATABASE_URL appears to use a transaction pooler (Supavisor/PgBouncer) " +
  "but DATABASE_MIGRATION_URL is not set. Prepared statements may break under " +
  "transaction-mode pooling. Set DATABASE_MIGRATION_URL to a direct connection " +
  "for schema/migration work, or disable prepared statements in the runtime pool.";

/**
 * Check whether a pooler warning should be emitted for the resolved backend,
 * and return the warning message if so.
 *
 * A warning is emitted when:
 *   - The backend is external (DATABASE_URL is set).
 *   - The runtime URL looks like a pooler connection.
 *   - DATABASE_MIGRATION_URL was NOT explicitly set.
 *
 * Returns `null` when no warning is needed.
 */
export function poolerWarning(
  backend: ResolvedBackend,
): string | null {
  if (backend.mode !== "external") return null;
  if (backend.migrationUrlOverridden) return null;
  if (!backend.runtimeUrl) return null;
  if (!looksLikePoolerUrl(backend.runtimeUrl)) return null;
  return POOLER_PREPARED_STATEMENT_WARNING;
}

/**
 * Produce a log-safe description of the resolved backend for startup logging.
 * Never includes the password (uses credential redaction).
 */
export function describeBackendForLog(backend: ResolvedBackend): string {
  if (backend.mode === "embedded") {
    return "embedded backend resolved (DATABASE_URL unset) — embedded lifecycle will provide the connection";
  }
  const safeRuntime = backend.runtimeUrl
    ? redactConnectionString(backend.runtimeUrl)
    : "<unknown>";
  const parts = [`external backend resolved (DATABASE_URL set): ${safeRuntime}`];
  if (backend.migrationUrlOverridden && backend.migrationUrl) {
    parts.push(
      `DATABASE_MIGRATION_URL overrides schema-work target: ${redactConnectionString(backend.migrationUrl)}`,
    );
  }
  return parts.join(" | ");
}

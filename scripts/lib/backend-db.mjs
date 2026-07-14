/**
 * FNXC:PostgresCutover 2026-07-05-13:00:
 * Shared PostgreSQL backend access for operational scripts.
 *
 * The ops/maintenance scripts under scripts/ used to open `.fusion/fusion.db`
 * directly (node:sqlite or the sqlite3 CLI). After the PostgreSQL cutover the
 * live data lives in the embedded PostgreSQL cluster (or an external cluster
 * via DATABASE_URL), so a direct SQLite open would silently operate on a
 * stale/empty marker file. Every script now boots the real backend through
 * @fusion/core's startup factory via this helper.
 *
 * Requires packages/core to be built (`pnpm --filter @fusion/core build`).
 */
import { cpSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Stage the PostgreSQL migration SQL into core's dist. `tsc` emits
 * only JS, so dist lacks src/postgres/migrations/*.sql; the schema applier
 * resolves them relative to the compiled file (__dirname/migrations). The CLI
 * bundle does the same staging in packages/cli/tsup.config.ts.
 */
function ensureMigrationsStaged() {
  const src = resolve(repoRoot, "packages/core/src/postgres/migrations");
  const dest = resolve(repoRoot, "packages/core/dist/postgres/migrations");
  /*
   * FNXC:AutomationIsolation 2026-07-13-22:37:
   * Operational scripts must stage every versioned PostgreSQL migration, not merely the initial baseline, so an already-initialized database receives the automation project-isolation upgrade before scripts open it.
   */
  const requiredMigrations = existsSync(src)
    ? readdirSync(src).filter((file) => file.endsWith(".sql"))
    : [];
  if (existsSync(src) && requiredMigrations.some((file) => !existsSync(resolve(dest, file)))) {
    cpSync(src, dest, { recursive: true });
  }
}

async function importCore() {
  ensureMigrationsStaged();
  try {
    return await import(pathToFileURL(resolve(repoRoot, "packages/core/dist/index.js")).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to import packages/core/dist/index.js (${message}). Run: pnpm --filter @fusion/core build`,
    );
  }
}

/**
 * Boot a PostgreSQL-backed TaskStore for the given project root.
 *
 * Returns `{ core, store, asyncLayer, sql, schema, shutdown }`:
 * - `core` — the @fusion/core module (for helpers like recordRunAuditEvent).
 * - `store` — the initialized TaskStore (backend mode).
 * - `asyncLayer` — the AsyncDataLayer; `asyncLayer.db.execute(sql\`...\`)`
 *   runs raw SQL. Project tables are schema-qualified (`project."tasks"`).
 * - `sql` — the drizzle-orm `sql` template tag (re-exported as drizzleSql).
 * - `schema` — postgresSchema (drizzle table objects, e.g. schema.project.tasks).
 * - `shutdown` — releases the pool and stops an embedded cluster this boot
 *   started. Always call it in `finally`.
 *
 * Throws when the factory opts out (FUSION_NO_EMBEDDED_PG=1): these scripts
 * must never fall back to the removed SQLite runtime.
 */
export async function openBackend(rootDir = process.cwd()) {
  const core = await importCore();
  const boot = await core.createTaskStoreForBackend({ rootDir });
  if (!boot) {
    throw new Error(
      "PostgreSQL backend unavailable (FUSION_NO_EMBEDDED_PG=1 opt-out is set). " +
        "This script requires the PostgreSQL backend; the SQLite runtime was removed.",
    );
  }
  const asyncLayer = boot.taskStore.getAsyncLayer();
  if (!asyncLayer) {
    await boot.shutdown().catch(() => {});
    throw new Error("Backend TaskStore has no AsyncDataLayer; cannot run this script.");
  }
  return {
    core,
    store: boot.taskStore,
    asyncLayer,
    sql: core.drizzleSql,
    schema: core.postgresSchema,
    shutdown: boot.shutdown,
  };
}

/**
 * Normalize a drizzle `db.execute(...)` result to a plain array of rows.
 * postgres-js returns a RowList (array-like); this keeps call sites simple.
 */
export function rowsOf(result) {
  if (Array.isArray(result)) return [...result];
  if (result && Array.isArray(result.rows)) return [...result.rows];
  return [];
}

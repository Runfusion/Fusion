import { resolve as resolvePath } from "node:path";
import {
  checkPostgresHealth,
  getSqliteMigrationState,
  detectTaskIdIntegrityAnomaliesAsync,
  type AsyncDataLayer,
  type TaskIdIntegrityReport,
  type TaskStore,
} from "@fusion/core";

export type DashboardTaskIdIntegrityHealth =
  | TaskIdIntegrityReport
  | {
      status: "error";
      checkedAt: string;
      anomalies: [];
      error: string;
    };

export interface DashboardMigrationHealth {
  active: false;
  durableStatus: "running" | "failed";
  phase: "running" | "failed";
  label: string;
  lastError: string | null;
  migrationKey: string;
  updatedAt: string;
}

export interface DashboardPostgresHealthResult {
  database: ReturnType<TaskStore["getDatabaseHealth"]>;
  taskIdIntegrity: DashboardTaskIdIntegrityHealth;
  migration?: DashboardMigrationHealth;
}

/** Typed server-owned context for health probes that need project partitioning. */
export interface DashboardPostgresHealthContext {
  projectId?: string;
  probeTimeoutMs?: number;
}

class HealthProbeTimeoutError extends Error {}

function withDeadline<T>(start: () => Promise<T>, remainingMs: number, label: string): Promise<T> {
  if (remainingMs <= 0) return Promise.reject(new HealthProbeTimeoutError(`${label} timed out after ${remainingMs}ms`));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HealthProbeTimeoutError(`${label} timed out after ${remainingMs}ms`)), remainingMs);
    // Start only while budget remains; a later stage must not queue a new DB
    // request after an earlier stage used the shared health-probe deadline.
    void start().then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Resolve the production TaskStore layer while retaining an explicit integration override. */
export function resolveDashboardPostgresLayer(
  store: TaskStore,
  overrideLayer?: AsyncDataLayer,
): AsyncDataLayer | null {
  return overrideLayer ?? store.getAsyncLayer();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/*
FNXC:PostgresHealth 2026-07-14-23:45:
The dashboard health surface is a PostgreSQL readiness signal, not a legacy SQLite compatibility probe. Resolve the TaskStore-owned AsyncDataLayer by default, allow an explicit layer only as an integration override, and fail closed when connectivity or task-ID integrity cannot be verified.
*/
export async function evaluateDashboardPostgresHealth(
  store: TaskStore,
  overrideLayer?: AsyncDataLayer,
  context?: DashboardPostgresHealthContext,
): Promise<DashboardPostgresHealthResult> {
  /*
  FNXC:PostgresHealth 2026-08-09-06:07:
  A liveness probe must answer when scheduler work saturates the runtime pool. Return a timeout degradation rather than leaving the HTTP request unanswered; migration state remains advisory and cannot make a healthy readiness result fail.
  */
  const checkedAt = new Date();
  const timeoutMs = context?.probeTimeoutMs ?? 5_000;
  const deadlineMs = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadlineMs - Date.now());
  let layer: AsyncDataLayer | null = null;
  try {
    layer = resolveDashboardPostgresLayer(store, overrideLayer);
  } catch (error) {
    const message = `PostgreSQL health layer resolution failed: ${errorMessage(error)}`;
    return failedHealth(checkedAt, message);
  }

  if (!layer) return failedHealth(checkedAt, "PostgreSQL health layer unavailable");

  const errors = await withDeadline(() => checkPostgresHealth(layer), remaining(), "PostgreSQL health probe").catch((error: unknown) => [
    error instanceof HealthProbeTimeoutError
      ? `PostgreSQL health probe timed out after ${timeoutMs}ms (connection pool saturated?)`
      : `PostgreSQL health check failed: ${errorMessage(error)}`,
  ]);
  if (errors.length > 0) return failedHealth(checkedAt, ...errors);

  let taskIdIntegrity: DashboardTaskIdIntegrityHealth;
  try {
    taskIdIntegrity = await withDeadline(() => detectTaskIdIntegrityAnomaliesAsync(layer.db), remaining(), "PostgreSQL task-ID integrity probe");
  } catch (error) {
    return failedHealth(
      checkedAt,
      error instanceof HealthProbeTimeoutError
        ? `PostgreSQL task-ID integrity probe timed out after ${timeoutMs}ms (connection pool saturated?)`
        : `PostgreSQL task-ID integrity check failed: ${errorMessage(error)}`,
    );
  }

  try {
    const migration = await withDeadline(() => resolveDashboardMigrationHealth(store, layer, context), remaining(), "PostgreSQL migration health probe");
    return {
      database: healthyDatabase(checkedAt),
      taskIdIntegrity,
      ...(migration ? { migration } : {}),
    };
  } catch {
    // Migration status is advisory after connectivity and task-ID queries pass.
    return { database: healthyDatabase(checkedAt), taskIdIntegrity };
  }
}

/*
FNXC:MigrationStatusDashboard 2026-07-19-14:30:
After the real server is listening, durable running and failed markers are
incomplete cutovers, not live progress. The typed server context carries the
engine's bound project id, because TaskStore does not promise an ad-hoc getter;
otherwise preserve startup-factory's absolute-root migration-key shape. No
updated_at age threshold is valid because progress does not refresh it.
*/
async function resolveDashboardMigrationHealth(
  store: TaskStore,
  layer: AsyncDataLayer,
  context?: DashboardPostgresHealthContext,
): Promise<DashboardMigrationHealth | undefined> {
  const boundProjectId = context?.projectId?.trim() || undefined;
  const rootDir = typeof store.getRootDir === "function" ? store.getRootDir() : undefined;
  // Compatibility-only test/integration stores without a root cannot identify a project marker.
  if (!boundProjectId && !rootDir) return undefined;
  const migrationKey = boundProjectId
    ? `project:${boundProjectId}`
    : `project:${resolvePath(rootDir!)}`;
  const state = await getSqliteMigrationState(layer.db, migrationKey);
  if (state?.status !== "running" && state?.status !== "failed") return undefined;
  const status = state.status;
  const lastError = state.lastError;
  return {
    active: false,
    durableStatus: status,
    phase: status,
    label: status === "running"
      ? "SQLite → PostgreSQL migration incomplete (status: running). Do not delete legacy .fusion/fusion.db backups. Re-run migration or check logs."
      : `SQLite → PostgreSQL migration failed: ${lastError ?? "unknown error"}. Legacy SQLite files were retained as backups; see docs/storage.md and run 'fn db migrate' after fixing the error.`,
    lastError,
    migrationKey: state.migrationKey,
    updatedAt: new Date(state.updatedAt).toISOString(),
  };
}

function healthyDatabase(checkedAt: Date): DashboardPostgresHealthResult["database"] {
  return {
    healthy: true,
    corruptionDetected: false,
    corruptionErrors: [],
    lastCheckedAt: checkedAt,
    isRunning: false,
  };
}

function failedHealth(
  checkedAt: Date,
  ...errors: string[]
): DashboardPostgresHealthResult {
  const visibleErrors = errors.slice(0, 5);
  const error = visibleErrors.join("; ");
  return {
    database: {
      healthy: false,
      corruptionDetected: false,
      corruptionErrors: visibleErrors,
      lastCheckedAt: checkedAt,
      isRunning: false,
    },
    taskIdIntegrity: {
      status: "error",
      checkedAt: checkedAt.toISOString(),
      anomalies: [],
      error,
    },
  };
}

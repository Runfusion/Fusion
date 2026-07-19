import {
  checkPostgresHealth,
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

export interface DashboardPostgresHealthResult {
  database: ReturnType<TaskStore["getDatabaseHealth"]>;
  taskIdIntegrity: DashboardTaskIdIntegrityHealth;
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
): Promise<DashboardPostgresHealthResult> {
  const checkedAt = new Date();
  let layer: AsyncDataLayer | null = null;
  try {
    layer = resolveDashboardPostgresLayer(store, overrideLayer);
  } catch (error) {
    const message = `PostgreSQL health layer resolution failed: ${errorMessage(error)}`;
    return failedHealth(checkedAt, message);
  }

  if (!layer) return failedHealth(checkedAt, "PostgreSQL health layer unavailable");

  const errors = await checkPostgresHealth(layer).catch((error: unknown) => [
    `PostgreSQL health check failed: ${errorMessage(error)}`,
  ]);
  if (errors.length > 0) return failedHealth(checkedAt, ...errors);

  try {
    const taskIdIntegrity = await detectTaskIdIntegrityAnomaliesAsync(layer.db);
    return {
      database: healthyDatabase(checkedAt),
      taskIdIntegrity,
    };
  } catch (error) {
    return failedHealth(
      checkedAt,
      `PostgreSQL task-ID integrity check failed: ${errorMessage(error)}`,
    );
  }
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
      corruptionDetected: true,
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

import { resolve as resolvePath } from "node:path";
import {
  checkPostgresHealth,
  getSqliteMigrationState,
  detectTaskIdIntegrityAnomaliesAsync,
  DEFAULT_HEALTH_PROBE_BUDGET_MS,
  type AsyncDataLayer,
  type TaskIdIntegrityReport,
  type TaskStore,
} from "@fusion/core";

/**
 * Why a health probe stopped, as an evidence class rather than a guess.
 *
 * FNXC:TaskIdIntegrityCanary 2026-09-26-00:55 (RUFU-301):
 * Every failure used to recommend "Restore PostgreSQL connectivity", which sent
 * operators to the wrong door: measured against an `ACCESS EXCLUSIVE` lock on
 * `project.tasks`, `pg_isready` answered `accepting connections` and `SELECT 1`
 * succeeded while the integrity reads timed out. A deadline expiry is proof the
 * measurement did not finish, not proof the server is down, so the two are now
 * separate classes and the recommended action follows the evidence.
 */
export type DashboardHealthFailureClass =
  /** No layer to probe (misconfiguration, or a store without a PostgreSQL layer). */
  | "unconfigured"
  /** PostgreSQL refused or dropped the connection itself. */
  | "unreachable"
  /** PostgreSQL was contacted, but a stage could not be measured inside its budget. */
  | "incomplete";

export type DashboardTaskIdIntegrityHealth =
  | TaskIdIntegrityReport
  | {
      status: "error";
      checkedAt: string;
      anomalies: [];
      error: string;
      failure: DashboardHealthFailureClass;
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

/*
FNXC:TaskIdIntegrityCanary 2026-09-26-01:50 (RUFU-301):
Pair invariant: `corruptionDetected: false` is a *completed-clean* verdict, so it
may never travel with a blocking integrity or connectivity error. Publishing it
next to "integrity probe timed out" told operators the canary had run and come
back clean when no query had finished — the exact blindness this change removes.

The field stays a boolean on purpose rather than gaining a `null` "not measured"
state: every consumer of a corruption canary truthiness-checks it, and a nullable
verdict would read as falsy-clean at exactly those call sites, relocating the
blindness instead of removing it. So an unfinished measurement fails closed to
`true` — matching core's own rule in `refreshDatabaseHealthAsyncImpl`
(`corruptionDetected: errors.length > 0`) — and the *reason* stays machine-readable
in `taskIdIntegrity.status: "error"` plus its `failure` evidence class, which is
where "not verified" is distinguishable from "verified corrupt".
*/
/*
FNXC:PostgresHealth 2026-10-15-13:28 (RUFU-302):
The published health contract enumerates ONLY measured signals. This type used to
be `ReturnType<TaskStore["getDatabaseHealth"]>`, which dragged the store's
transient `isRunning` flag ("true while an asynchronous health check is in
progress") into an operator-facing API — both producers hardcoded it to `false`,
so it was a constant, not a measurement. RUFU-301's incident report read
`database.isRunning:false` as proof the database was dead; it proved nothing.
An open derivation is what let store bookkeeping reach the wire, so the shape is
now written out explicitly and `isRunning` is simply absent. The core store
snapshot keeps its internal probe-in-progress flag for its own use; it is
intentionally NOT published. `lastCheckedAt` stays `Date | null` here (the
producer's own clock) and serializes to an ISO string on the wire.
*/
export interface DashboardDatabaseHealth {
  healthy: boolean;
  corruptionDetected: boolean;
  corruptionErrors: string[];
  lastCheckedAt: Date | null;
}

export interface DashboardPostgresHealthResult {
  database: DashboardDatabaseHealth;
  taskIdIntegrity: DashboardTaskIdIntegrityHealth;
  migration?: DashboardMigrationHealth;
}

/** Typed server-owned context for health probes that need project partitioning. */
export interface DashboardPostgresHealthContext {
  projectId?: string;
  probeTimeoutMs?: number;
}

/*
FNXC:TaskIdIntegrityCanary 2026-09-26-01:00 (RUFU-301):
The timeout sentence used to name the *total* probe budget, so a stage that had
2.5 s left and never finished still claimed it "timed out after 5000ms". That
misattribution made the budget look too small when the real problem was an
earlier stage consuming it, and it hid which stage to investigate. The error now
carries its own stage budget plus the elapsed time.
*/
class HealthProbeTimeoutError extends Error {
  readonly stage: string;
  readonly stageBudgetMs: number;
  readonly elapsedMs: number;

  constructor(stage: string, stageBudgetMs: number, elapsedMs: number, probeBudgetMs: number) {
    super(
      `${stage} did not complete within its ${stageBudgetMs}ms stage budget `
        + `(${elapsedMs}ms elapsed of a ${probeBudgetMs}ms probe)`,
    );
    this.name = "HealthProbeTimeoutError";
    this.stage = stage;
    this.stageBudgetMs = stageBudgetMs;
    this.elapsedMs = elapsedMs;
  }
}

function withDeadline<T>(
  start: () => Promise<T>,
  remainingMs: number,
  label: string,
  probeBudgetMs: number,
): Promise<T> {
  const startedAt = Date.now();
  const timeout = (budgetMs: number) =>
    new HealthProbeTimeoutError(label, budgetMs, Math.max(0, Date.now() - startedAt), probeBudgetMs);
  if (remainingMs <= 0) return Promise.reject(timeout(0));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeout(remainingMs)), remainingMs);
    // Start only while budget remains; a later stage must not queue a new DB
    // request after an earlier stage used the shared health-probe deadline.
    void start().then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/**
 * Classify a connectivity-stage failure that arrived as a THROWN error.
 *
 * A deadline expiry during the connectivity stage is `incomplete`: measured on
 * the wedged `max: 1` health session, polls 2 and 3 timed out here purely
 * because their `SELECT 1` queued behind an orphaned detector read, on a server
 * that answered `pg_isready` happily. A connection-level error is `unreachable`.
 *
 * FNXC:TaskIdIntegrityCanary 2026-09-26-04:20 (RUFU-301):
 * This is only the throw half of the connectivity verdict. `checkPostgresHealth`
 * reports an unreachable backend by RESOLVING a non-empty verdict list, so the
 * sibling classification for that shape lives at the call site below — a thrown
 * error and a resolved verdict list must not be collapsed into one path.
 */
function classifyConnectivityError(error: unknown): DashboardHealthFailureClass {
  if (error instanceof HealthProbeTimeoutError) return "incomplete";
  const message = errorMessage(error).toLowerCase();
  const connectionShape =
    /connect|econnrefused|econnreset|etimedout|enotfound|eai_again|network|socket|closed|terminat|pool|carry no command/.test(
      message,
    );
  return connectionShape ? "unreachable" : "incomplete";
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
  FNXC:PostgresHealthTransport 2026-09-23-02:09:
  A liveness probe must stay independent of scheduler runtime-pool contention.
  Dedicated connectivity and integrity reads still degrade on actual failure or
  deadline expiry; migration state remains advisory and cannot make readiness fail.
  */
  const checkedAt = new Date();
  const timeoutMs = context?.probeTimeoutMs ?? DEFAULT_HEALTH_PROBE_BUDGET_MS;
  const deadlineMs = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadlineMs - Date.now());
  let layer: AsyncDataLayer | null = null;
  try {
    layer = resolveDashboardPostgresLayer(store, overrideLayer);
  } catch (error) {
    const message = `PostgreSQL health layer resolution failed: ${errorMessage(error)}`;
    return failedHealth(checkedAt, "unconfigured", message);
  }

  if (!layer) return failedHealth(checkedAt, "unconfigured", "PostgreSQL health layer unavailable");

  /*
  FNXC:TaskIdIntegrityCanary 2026-09-26-04:20 (RUFU-301):
  `checkPostgresHealth` never rejects for a dead backend: it catches the ping
  failure and RESOLVES `["PostgreSQL backend unreachable: connect ECONNREFUSED
  …"]` (same shape for a failed health query or `datallowconn = false`), and its
  contract obliges the caller to surface the DB-corruption banner (VAL-HEALTH-002)
  on a non-empty list. Dropping that list made a downed PostgreSQL fall through
  into the integrity stage, whose rejection was then published as
  `failure: "incomplete"` — "we reached the database, only the measurement is
  missing" — while the ECONNREFUSED evidence appeared nowhere and the generic
  corruption banner was suppressed. The stage's resolved verdict is therefore
  inspected, not discarded: it is connectivity evidence, so the original
  sentences ride into `corruptionErrors` verbatim and the loud banner stays up.
  Only an empty list means "connectivity measured clean, continue probing".
  */
  const connectivity = await withDeadline(
    () => checkPostgresHealth(layer),
    remaining(),
    "PostgreSQL health probe",
    timeoutMs,
  ).then((verdicts) =>
    verdicts.length === 0
      ? null
      : { failure: "unreachable" as const, messages: verdicts },
  ).catch((error: unknown) => ({
    failure: classifyConnectivityError(error),
    messages: [
      error instanceof HealthProbeTimeoutError
        ? `PostgreSQL health probe ${error.message}`
        : `PostgreSQL health check failed: ${errorMessage(error)}`,
    ],
  }));
  if (connectivity) return failedHealth(checkedAt, connectivity.failure, ...connectivity.messages);

  /*
  FNXC:TaskIdIntegrity 2026-09-23-01:47:
  Health must inspect one authoritative task-ID partition. Prefer the engine's
  typed project identity, then the bound data-layer identity; only a genuinely
  unbound caller retains the detector's intentional global diagnostic mode.
  */
  const taskIdIntegrityProjectId = context?.projectId?.trim() || layer.projectId?.trim() || undefined;
  let taskIdIntegrity: DashboardTaskIdIntegrityHealth;
  try {
    taskIdIntegrity = await withDeadline(
      () => detectTaskIdIntegrityAnomaliesAsync(layer.healthDb, { projectId: taskIdIntegrityProjectId }),
      remaining(),
      "PostgreSQL task-ID integrity probe",
      timeoutMs,
    );
  } catch (error) {
    // The connectivity stage passed, so PostgreSQL is contactable; whatever
    // stopped here (deadline, server-side cancellation, driver error) is an
    // unfinished measurement, never a clean result.
    return failedHealth(
      checkedAt,
      "incomplete",
      error instanceof HealthProbeTimeoutError
        ? `PostgreSQL task-ID integrity probe ${error.message}`
        : `PostgreSQL task-ID integrity check failed: ${errorMessage(error)}`,
    );
  }

  try {
    const migration = await withDeadline(
      () => resolveDashboardMigrationHealth(store, layer, context),
      remaining(),
      "PostgreSQL migration health probe",
      timeoutMs,
    );
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

function healthyDatabase(checkedAt: Date): DashboardDatabaseHealth {
  return {
    healthy: true,
    corruptionDetected: false,
    corruptionErrors: [],
    lastCheckedAt: checkedAt,
  };
}

function failedHealth(
  checkedAt: Date,
  failure: DashboardHealthFailureClass,
  ...errors: string[]
): DashboardPostgresHealthResult {
  const visibleErrors = errors.slice(0, 5);
  const error = visibleErrors.join("; ");
  return {
    database: {
      healthy: false,
      // Fail closed: an unmeasured canary is never reported as clean. The
      // "not verified" distinction lives in taskIdIntegrity.status/failure below.
      corruptionDetected: true,
      corruptionErrors: visibleErrors,
      lastCheckedAt: checkedAt,
    },
    taskIdIntegrity: {
      status: "error",
      checkedAt: checkedAt.toISOString(),
      anomalies: [],
      error,
      failure,
    },
  };
}
